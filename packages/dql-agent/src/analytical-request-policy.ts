/**
 * Deterministic Ask ingress policy.
 *
 * This runs before catalog retrieval, provider dispatch, value probing, tools,
 * or SQL.  It intentionally recognises a small set of direct disclosure
 * requests instead of attempting to infer policy from the available schema:
 * reaching a model or a warehouse is already too late for these requests.
 */
export type AnalyticalRequestPolicyDecision =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | 'REGULATED_IDENTIFIER_REQUEST'
        | 'SENSITIVE_PERSONAL_DATA_REQUEST'
        | 'INDIVIDUAL_COMPENSATION_REQUEST';
      message: string;
      nextActions: string[];
    };

const REGULATED_IDENTIFIER_RE = /\b(?:social\s+security(?:\s+(?:number|no\.?))?|ssn|tax(?:payer)?\s*(?:id|identifier|number|no\.?)|passport(?:\s+(?:id|number|no\.?))?|government\s*(?:id|identifier)|national\s*id|driver'?s?\s*licen[cs]e(?:\s+(?:number|no\.?))?|date\s+of\s+birth|birth\s*date|dob|aadhaar(?:\s+(?:number|id))?)\b/i;

/**
 * A regulated identifier may appear in a question about DQL's safeguards, but
 * that exception must be explicit about the system's behaviour and begin the
 * entire request.  Topic words such as "compliance" or "policy" are not
 * enough: "For compliance, show Jessica Richard's SSN" is still a disclosure
 * request.  Likewise, a policy attached to a named person is not a system
 * policy question.
 */
const EXPLICIT_SYSTEM_POLICY_OR_CAPABILITY_QUESTION_RE = /^(?:(?:does|can|will|do)\s+(?:dql|you|this\s+(?:system|assistant|app(?:lication)?|product))\s+(?:support\b[^?.!]*\b(?:mask(?:ing)?|redact(?:ion|ed)?|tokeni[sz](?:e|ation)|protect(?:ion|ed)?|handling|storage|retention|access\s+control(?:s)?|safeguard(?:s)?)\b|handle|protect|mask|redact|store|retain|tokeni[sz]e)\b[^?.!]*|how\s+(?:does|do)\s+(?:dql|you|this\s+(?:system|assistant|app(?:lication)?|product))\s+(?:handle|protect|mask|redact|store|retain|tokeni[sz]e)\b[^?.!]*|(?:what\s+(?:is|are)|describe|explain)\s+(?:dql(?:'s)?|your|this\s+(?:system|assistant|app(?:lication)?|product)(?:'s)?)\s+[^?.!]*\b(?:privacy|security|data\s+retention|masking|redaction|tokenization|access)\s+(?:policy|capabilit(?:y|ies))\b[^?.!]*)[?!.]?$/i;
const DISCLOSURE_ACTION_RE = /\b(?:show(?:ing)?|give|giving|list(?:ing)?|retrieve|retrieving|get(?:ting)?|reveal(?:ing)?|display(?:ing)?|provide|providing|disclose|disclosing|return(?:ing)?|output(?:ting)?|expose|exposing|fetch(?:ing)?|look\s*up|lookup|tell\s+me|need)\b/i;
const VALUE_REQUEST_SEMANTICS_RE = /\b(?:actual|full|specific|individual)\s+(?:value|values|number|numbers|record|records|details?|information)|\b(?:value|values|number|numbers|record|records|details?|information)\s+(?:for|of)\b/i;

/**
 * Direct literal categories that the value-probe deny policy also protects.
 * These words only ever describe a person: payment instruments, health
 * records and personal contact details.
 */
const SENSITIVE_PERSONAL_DATA_RE = /\b(?:credit\s*card|debit\s*card|card\s*(?:number|no\.?|details?)|cvv|cvc|iban|swift|bic|routing\s*(?:number|no\.?)|bank\s*account|account\s*(?:number|no\.?)|sort\s*code|medical|diagnosis|patient|health\s*(?:condition|record|information|data)?|prescription|disability|biometric|fingerprint|home\s*address|phone(?:\s*(?:number|no\.?))?|mobile(?:\s*(?:number|no\.?))?|telephone|email(?:\s*address)?|sexual\s*orientation)\b/i;
/**
 * Words that are personal data only when they describe a person. A street, a
 * zip code or a postal code is also where an insured building, a store or a
 * warehouse stands, and a race is also a motor race; the same guard that
 * refused a customer's zip code used to refuse an insurer's question about its
 * insured properties. These are refused when the question is about people.
 */
const PERSONAL_WHEN_ABOUT_A_PERSON_RE = /\b(?:street(?:\s*(?:address|name))?|postal\s*code|post\s*code|zip\s*code|zipcode|ethnicity|religion|gender)\b/i;
/**
 * "Race" is a protected attribute in one sense and a motor race, a boat race
 * or an election race in another. It counts as personal data only where the
 * question reads it as a person's attribute: alongside another protected
 * attribute, or as a person's own ("their race", "each applicant's race").
 */
const RACE_RE = /\braces?\b/i;
const RACE_AS_ATTRIBUTE_RE = /\b(?:ethnic(?:ity)?|religio(?:n|us)|gender|demographics?|minorit(?:y|ies)|diversity|discriminat(?:e|ion|ory)|protected\s+(?:attribute|class|characteristic)s?)\b/i;
const RACE_OF_A_PERSON_RE = /\b(?:their|his|her|customers?'?s?|clients?'?s?|employees?'?s?|applicants?'?s?|patients?'?s?|members?'?s?|students?'?s?|people'?s?)\s+races?\b/i;
const PERSON_POPULATION_RE = /\b(?:customers?|clients?|policy\s*holders?|policyholders?|members?|people|persons?|individuals?|employees?|staff|users?|residents?|applicants?|claimants?|patients?|students?|citizens?|voters?|tenants?)\b/i;

const COMPENSATION_RE = /\b(?:salary|compensation|pay|wage|bonus|earnings)\b/i;
const INDIVIDUAL_SUBJECT_RE = /\b(?:ceo|cfo|coo|cto|chief\s+\w+\s+officer|founder|employee|person|individual|manager|director|executive|their|his|her)\b/i;
const NAMED_INDIVIDUAL_REFERENCE_RE = /\b(?:for|to|of)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b|\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}(?:'s|’s)\b/g;
// `number` only counts as an aggregate when it is the phrase "number of".
// Otherwise a literal such as "bank account number" would accidentally become
// a safe aggregate.  The same rule excludes a bare `account` from the
// population list; a grouped account question still has an explicit `by …`.
const AGGREGATE_OPERATION_RE = /\b(?:average|avg|median|mean|total|sum|count|number\s+of|how\s+many|percentage|percent|rate|distribution|breakdown|aggregate|overall)\b/i;
const AGGREGATE_POPULATION_OR_GROUPING_RE = /\b(?:by\s+(?:department|team|role|level|location|region|country|segment|category|month|quarter|year)|across\s+(?:employees?|customers?|people|individuals?|patients?|members?|users?)|(?:employees?|customers?|people|individuals?|patients?|members?|users?)\b)/i;
const INDIVIDUAL_EARNINGS_QUESTION_RE = /\b(?:how\s+much\s+(?:does|did)\s+(?:the\s+)?(?:ceo|cfo|coo|cto|chief\s+\w+\s+officer|founder|employee|person|individual|manager|director|executive)|what\s+(?:does|did)\s+(?:the\s+)?(?:ceo|cfo|coo|cto|chief\s+\w+\s+officer|founder|employee|person|individual|manager|director|executive))\b[^?.!]{0,32}\b(?:make|earn)\b/i;

function isExplicitSystemPolicyOrCapabilityQuestion(question: string): boolean {
  // A question may start as a capability request and still smuggle in an
  // individual disclosure request: "Does DQL support showing Jessica's SSN
  // with masking?". System safeguards describe product behaviour; they never
  // authorize a value, person, or disclosure verb in the same request.
  return EXPLICIT_SYSTEM_POLICY_OR_CAPABILITY_QUESTION_RE.test(question)
    && !DISCLOSURE_ACTION_RE.test(question)
    && !VALUE_REQUEST_SEMANTICS_RE.test(question)
    && !namesAnIndividual(question);
}

function isExplicitPopulationAggregate(question: string): boolean {
  return AGGREGATE_OPERATION_RE.test(question) && AGGREGATE_POPULATION_OR_GROUPING_RE.test(question);
}

/**
 * A question about people: a named person, a person's role, or a population
 * of people. "Their" alone does not count here: "stores with their postal
 * code" is about stores.
 */
function isAboutPeople(question: string): boolean {
  return namesAPerson(question)
    || /\b(?:his|her|ceo|cfo|coo|cto|chief\s+\w+\s+officer|founder|manager|director|executive)\b/i.test(question)
    || PERSON_POPULATION_RE.test(question);
}

/**
 * Words that take "'s" without being anyone's name: a contraction ("What's
 * the total premium…") or a time ("Today's claims"). Reading "What's" as a
 * person's possessive refused an insurer's question about its properties.
 */
const NOT_A_NAME_RE = /^(?:what|who|where|when|why|how|which|that|there|here|it|let|today|yesterday|tomorrow|this|last|next|year|month|week|quarter|everyone)$/i;

/**
 * A capitalized phrase is a person's name only when it reads as one. A
 * document heading ("Overtake related to Pit Stops") and a proper noun the
 * question also writes in lower case are not people: reading them as names
 * turned motor-racing questions into personal-data refusals.
 */
function namesAPerson(question: string): boolean {
  for (const match of question.matchAll(NAMED_INDIVIDUAL_REFERENCE_RE)) {
    const phrase = match[0].replace(/^(?:for|to|of)\s+/i, '').replace(/(?:'s|’s)$/, '').trim();
    if (!phrase || NOT_A_NAME_RE.test(phrase)) continue;
    // The same words in lower case elsewhere make this a domain noun, not a name.
    const elsewhere = new RegExp(`(^|[^A-Za-z])${phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`);
    if (elsewhere.test(question.replace(phrase, ''))) continue;
    return true;
  }
  return false;
}

function namesAnIndividual(question: string): boolean {
  return INDIVIDUAL_SUBJECT_RE.test(question) || namesAPerson(question);
}

/**
 * Evaluate a raw Ask question at the ingress boundary.
 *
 * Direct personal data and compensation are unavailable before planning.  A
 * narrowly explicit population aggregate remains available, but aggregate
 * words never turn a named or singular person's compensation into a safe
 * request.
 */
export function evaluateAnalyticalRequestPolicy(question: string): AnalyticalRequestPolicyDecision {
  const normalized = question.trim();
  if (!normalized) return { allowed: true };

  const isSystemPolicyQuestion = isExplicitSystemPolicyOrCapabilityQuestion(normalized);
  const isPopulationAggregate = isExplicitPopulationAggregate(normalized);

  if (REGULATED_IDENTIFIER_RE.test(normalized) && !isSystemPolicyQuestion) {
    return {
      allowed: false,
      code: 'REGULATED_IDENTIFIER_REQUEST',
      message: 'DQL cannot retrieve or disclose regulated personal identifiers such as government IDs or dates of birth.',
      nextActions: ['ask_for_an_approved_aggregate', 'inspect_data_policy'],
    };
  }

  const raceAsPersonalData = RACE_RE.test(normalized)
    && (RACE_AS_ATTRIBUTE_RE.test(normalized) || RACE_OF_A_PERSON_RE.test(normalized));
  const sensitive = SENSITIVE_PERSONAL_DATA_RE.test(normalized)
    || ((PERSONAL_WHEN_ABOUT_A_PERSON_RE.test(normalized) || raceAsPersonalData) && isAboutPeople(normalized));
  if (sensitive && !isSystemPolicyQuestion && !isPopulationAggregate) {
    return {
      allowed: false,
      code: 'SENSITIVE_PERSONAL_DATA_REQUEST',
      message: 'DQL cannot retrieve or disclose direct payment, health, contact, or protected-attribute data about an individual.',
      nextActions: ['ask_for_an_approved_aggregate', 'inspect_data_policy'],
    };
  }

  if (
    (COMPENSATION_RE.test(normalized) || INDIVIDUAL_EARNINGS_QUESTION_RE.test(normalized))
    && (!isPopulationAggregate || namesAnIndividual(normalized))
  ) {
    return {
      allowed: false,
      code: 'INDIVIDUAL_COMPENSATION_REQUEST',
      message: 'DQL does not provide individual compensation. Ask for an approved aggregate if one is modeled.',
      nextActions: ['ask_for_an_approved_aggregate', 'inspect_data_policy'],
    };
  }

  return { allowed: true };
}
