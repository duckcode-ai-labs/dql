import { describe, it, expect } from 'vitest';
import { classifyConversationalTurn, decideAgentAction, looksLikeComposeApp, looksLikeFollowUp, looksLikePriorAnswerExplanation, looksLikeDefinitionalAboutNamedObject } from './intent-controller.js';

describe('decideAgentAction', () => {
  it('composes an app when asked to build a dashboard, regardless of match', () => {
    const d = decideAgentAction({
      question: 'build me a dashboard for revenue by region',
      intent: 'ad_hoc_ranking',
      signals: { certifiedScore: 0.9 },
    });
    expect(d.action).toBe('compose_app');
  });

  it('composes an app for a "monitor over time" ask', () => {
    expect(decideAgentAction({ question: 'I want to monitor orders over time', intent: 'ad_hoc_ranking' }).action).toBe('compose_app');
  });

  it('keeps a generated report request in the analytical answer lane', () => {
    expect(decideAgentAction({ question: 'generate a report of total orders by city', intent: 'ad_hoc_ranking' }).action).not.toBe('compose_app');
  });

  it('answers directly when a certified block or metric fits confidently', () => {
    const d = decideAgentAction({
      question: 'what is our total revenue',
      intent: 'exact_certified_lookup',
      signals: { metricScore: 0.8 },
    });
    expect(d.action).toBe('answer');
    expect(d.confidence).toBeGreaterThan(0.8);
  });

  it('does NOT over-investigate a lookup that has a strong governed match', () => {
    // "trend" reads investigative, but a confident metric should still answer.
    const d = decideAgentAction({
      question: 'revenue trend',
      intent: 'driver_breakdown',
      signals: { metricScore: 0.7 },
    });
    expect(d.action).toBe('answer');
  });

  it('investigates an open-ended "why" question', () => {
    const d = decideAgentAction({ question: 'why is revenue down this month?', intent: 'diagnose_change', signals: { hasRetrieval: true } });
    expect(d.action).toBe('investigate');
  });

  it('investigates a breakdown/compare even without a perfect intent label', () => {
    expect(decideAgentAction({ question: 'break down orders by region', intent: 'ad_hoc_ranking', signals: { metricScore: 0.2 } }).action).toBe('investigate');
  });

  it('clarifies when context is missing', () => {
    const d = decideAgentAction({
      question: 'show me the numbers',
      intent: 'clarify',
      signals: { missingContext: ['Need a clearer business object and measure.'] },
    });
    expect(d.action).toBe('clarify');
    expect(d.clarifyingQuestion).toContain('business object');
  });

  it('clarifies honestly when nothing governed matches and it is not analytical', () => {
    expect(decideAgentAction({ question: 'widgets', intent: 'ad_hoc_ranking', signals: { hasRetrieval: false } }).action).toBe('clarify');
  });

  it('answers (never re-clarifies) when the user replies to a prior clarifying question', () => {
    // Short non-deictic replies to a clarify used to be re-classified fresh and
    // clarified again — an infinite loop. A reply to a "?" turn must proceed.
    const d = decideAgentAction({
      question: 'top 5',
      intent: 'clarify',
      signals: { missingContext: ['Which product set?'] },
      history: [
        { role: 'user', text: 'top customers who bought the top products with revenue' },
        { role: 'assistant', text: 'How many top-selling products should I consider (e.g. top 3, top 10)?' },
      ],
    });
    expect(d.action).toBe('answer');
  });

  it('always returns a human-facing reason', () => {
    for (const intent of ['exact_certified_lookup', 'clarify', 'driver_breakdown'] as const) {
      expect(decideAgentAction({ question: 'q', intent }).reason.length).toBeGreaterThan(10);
    }
  });
});

describe('classifyConversationalTurn', () => {
  it('classifies greetings', () => {
    for (const q of ['hi', 'hey', 'hello', 'hey!', 'good morning', 'hi there', 'yo']) {
      expect(classifyConversationalTurn(q)).toBe('greeting');
    }
  });

  it('classifies gratitude / acknowledgement', () => {
    for (const q of ['thanks', 'thank you', 'thanks!', 'got it', 'perfect', 'cheers', 'ok']) {
      expect(classifyConversationalTurn(q)).toBe('gratitude');
    }
  });

  it('classifies meta / capability questions', () => {
    for (const q of ['what can you do?', 'who are you', 'what is DQL', 'how do you work', 'how can you help']) {
      expect(classifyConversationalTurn(q)).toBe('meta_capability');
    }
  });

  it('classifies bounded conversation recap requests, including common typos', () => {
    for (const q of [
      'what we are talking about here?',
      'what we are reviewing in this chat',
      'what are we reviewing and discussing in the whole conversation?',
      'what are we revewing and discussing in whole conversaion?',
      'summarize our conversation',
      'where were we?',
      'thanks, can you walk me through what we just looked at?',
    ]) {
      expect(classifyConversationalTurn(q, true)).toBe('smalltalk');
    }
  });

  it('requires prior context and does not steal ordinary analytical review questions', () => {
    expect(classifyConversationalTurn('what we are reviewing in this chat')).toBeUndefined();
    expect(classifyConversationalTurn('review revenue by region', true)).toBeUndefined();
    expect(classifyConversationalTurn('what revenue changed by region?', true)).toBeUndefined();
  });

  it('does NOT claim a real data question, even with a polite opener', () => {
    expect(classifyConversationalTurn('hi, what is total revenue?')).toBeUndefined();
    expect(classifyConversationalTurn('thanks — now break it down by region')).toBeUndefined();
    expect(classifyConversationalTurn('show me top customers')).toBeUndefined();
    expect(classifyConversationalTurn('why is revenue down?')).toBeUndefined();
  });

  it('does NOT treat a long sentence starting with hi as a greeting', () => {
    expect(classifyConversationalTurn('hi can you compute the churn rate for enterprise accounts')).toBeUndefined();
  });
});

describe('decideAgentAction — conversational tier', () => {
  it('routes greetings/thanks/meta to converse before data routing', () => {
    expect(decideAgentAction({ question: 'hi', intent: 'clarify' }).action).toBe('converse');
    expect(decideAgentAction({ question: 'thanks!', intent: 'clarify' }).action).toBe('converse');
    const meta = decideAgentAction({ question: 'what can you do?', intent: 'clarify' });
    expect(meta.action).toBe('converse');
    expect(meta.category).toBe('capability');
  });

  it('carries the conversational kind and heuristic source', () => {
    const d = decideAgentAction({ question: 'hello', intent: 'clarify' });
    expect(d.conversationalKind).toBe('greeting');
    expect(d.source).toBe('heuristic');
  });

  it('still routes a data question with a polite opener through the data cascade', () => {
    const d = decideAgentAction({ question: 'hi, what is total revenue?', intent: 'exact_certified_lookup', signals: { metricScore: 0.8 } });
    expect(d.action).toBe('answer');
  });

  it('explains the latest result without starting another analytical run', () => {
    const d = decideAgentAction({
      question: 'is it monthly or daily revenue?',
      intent: 'exact_certified_lookup',
      signals: { metricScore: 0.9 },
      history: [
        { role: 'user', text: 'show top customers by revenue' },
        { role: 'assistant', text: 'Here are the top customers.' },
      ],
    });
    expect(d.action).toBe('converse');
    expect(d.conversationalKind).toBe('answer_explanation');
  });
});

describe('follow-up + compose-app detection', () => {
  it('detects build-an-app phrasing', () => {
    expect(looksLikeComposeApp('create a cockpit for sales')).toBe(true);
    expect(looksLikeComposeApp('what is revenue')).toBe(false);
  });

  it('detects deictic follow-ups only with history', () => {
    expect(looksLikeFollowUp('why?', true)).toBe(true);
    expect(looksLikeFollowUp('break that down by region', true)).toBe(true);
    expect(looksLikeFollowUp('why?', false)).toBe(false);
    expect(looksLikeFollowUp('what is total revenue', true)).toBe(false);
    expect(looksLikeFollowUp('what product they bought for this amount?', true)).toBe(true);
    expect(looksLikeFollowUp('which region does she belong to?', true)).toBe(true);
    expect(looksLikeFollowUp('what did he buy?', true)).toBe(true);
  });

  it('distinguishes prior-answer explanations from requested recalculations', () => {
    expect(looksLikePriorAnswerExplanation('is it monthly or daily revenue?', true)).toBe(true);
    expect(looksLikePriorAnswerExplanation('was that result monthly or daily?', true)).toBe(true);
    expect(looksLikePriorAnswerExplanation('which metric did you use?', true)).toBe(true);
    expect(looksLikePriorAnswerExplanation('what period does this result cover?', true)).toBe(true);
    expect(looksLikePriorAnswerExplanation('what does this amount represent?', true)).toBe(true);
    expect(looksLikePriorAnswerExplanation('is it monthly or daily revenue?', false)).toBe(false);
    expect(looksLikePriorAnswerExplanation('show it monthly', true)).toBe(false);
    expect(looksLikePriorAnswerExplanation('break this down by day', true)).toBe(false);
  });
});

describe('looksLikeDefinitionalAboutNamedObject', () => {
  const ids = ['dql:block:food_vs_drink_revenue', 'dql:block:top_customers', 'semantic:metric:revenue'];

  it('recognises a definitional question about an artifact it names', () => {
    // The plan cannot: it reads the artifact's OWN NAME as analytical intent —
    // `food_vs_drink_revenue` contains "vs" so the mode comes back `comparison`,
    // and `top_customers` contains "top" so it comes back `ranking`.
    expect(looksLikeDefinitionalAboutNamedObject('what is food_vs_drink_revenue?', ids)).toBe(true);
    expect(looksLikeDefinitionalAboutNamedObject('explain top_customers', ids)).toBe(true);
    expect(looksLikeDefinitionalAboutNamedObject('what does top_customers mean?', ids)).toBe(true);
    expect(looksLikeDefinitionalAboutNamedObject('define food_vs_drink_revenue', ids)).toBe(true);
    expect(looksLikeDefinitionalAboutNamedObject('tell me about top customers', ids)).toBe(true);
  });

  it('keeps a bare natural-language metric question out of the definition lane', () => {
    // A certified block may be named `monthly_revenue`, but a reader asking for
    // "monthly revenue" is asking for its value. The compatible certified plan
    // must retain execution authority; explicit meaning wording still explains
    // the same governed object without querying it.
    const monthlyRevenue = ['dql:block:monthly_revenue'];

    expect(looksLikeDefinitionalAboutNamedObject('What is monthly revenue?', monthlyRevenue)).toBe(false);
    expect(looksLikeDefinitionalAboutNamedObject('What does monthly revenue mean?', monthlyRevenue)).toBe(true);
    expect(looksLikeDefinitionalAboutNamedObject('What is monthly_revenue?', monthlyRevenue)).toBe(true);
  });

  it('keeps raw fully-qualified artifact identifiers on the definition path', () => {
    // A qualified ID is an explicit request about metadata, even if its leaf
    // is a plain metric name. It must not be confused with natural-language
    // value wording such as "What is monthly revenue?".
    expect(looksLikeDefinitionalAboutNamedObject(
      'What is semantic:metric:revenue?',
      ['semantic:metric:revenue'],
    )).toBe(true);
    expect(looksLikeDefinitionalAboutNamedObject(
      'What is dql:block:revenue?',
      ['dql:block:revenue'],
    )).toBe(true);
  });

  it('requires BOTH a definitional form and a named artifact', () => {
    // The form alone would swallow a real query; the name alone would swallow
    // "top_customers by region", which is an execution request.
    expect(looksLikeDefinitionalAboutNamedObject('what is our revenue', ['dql:block:top_customers'])).toBe(false);
    expect(looksLikeDefinitionalAboutNamedObject('top_customers', ids)).toBe(false);
    expect(looksLikeDefinitionalAboutNamedObject('what are the top products by revenue?', ids)).toBe(false);
  });

  it('vetoes a definitional opener that turns into a data request', () => {
    expect(looksLikeDefinitionalAboutNamedObject('what is top_customers by region', ids)).toBe(false);
    expect(looksLikeDefinitionalAboutNamedObject('explain top_customers for the last quarter', ids)).toBe(false);
    expect(looksLikeDefinitionalAboutNamedObject('what is top_customers grouped by city', ids)).toBe(false);
  });

  it('handles no candidates and short names without false positives', () => {
    expect(looksLikeDefinitionalAboutNamedObject('what is food_vs_drink_revenue?', [])).toBe(false);
    expect(looksLikeDefinitionalAboutNamedObject('what is it', ['dql:block:it'])).toBe(false);
  });
});
