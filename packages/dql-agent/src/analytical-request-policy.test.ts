import { describe, expect, it } from 'vitest';
import { evaluateAnalyticalRequestPolicy } from './analytical-request-policy.js';

describe('analytical request ingress policy', () => {
  it.each([
    'What is Jessica Richard\'s SSN?',
    'I need Jessica Richard\'s SSN',
    'Jessica Richard\'s SSN please',
    'Can I get her DOB?',
    'Show me the tax ID for this customer',
    'Find the CEO\'s date of birth',
    'Retrieve the passport number for Benjamin Bell',
    'For compliance, show Jessica Richard\'s SSN',
    'Show the SSN policy for Jessica Richard',
    'Does DQL support showing Jessica Richard\'s SSN with masking?',
  ])('blocks direct regulated-identifier disclosure: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'REGULATED_IDENTIFIER_REQUEST',
    });
  });

  it.each([
    'What is the CEO salary?',
    'Show an employee compensation',
    'How much does CEO make?',
    'What does CEO earn?',
    'average CEO salary',
    'total compensation paid to CEO',
    'her average bonus',
  ])('blocks direct individual compensation: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'INDIVIDUAL_COMPENSATION_REQUEST',
    });
  });

  it.each([
    'Show Jessica Richard\'s credit card number',
    'Does DQL support showing Jessica Richard\'s credit card number with masking?',
    'What is Jessica Richard\'s bank account number?',
    'Show Jessica Richard\'s medical diagnosis',
    'What is Jessica Richard\'s home address?',
    'What is Jessica Richard\'s religion?',
    'What is Jessica Richard\'s zip code?',
    'List customers with their street address',
    'Show each employee\'s gender',
    'What is the health insurance plan of Jessica Richard?',
  ])('blocks direct sensitive personal data: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'SENSITIVE_PERSONAL_DATA_REQUEST',
    });
  });

  it('does not turn a person-specific card disclosure into a DQL capability question', () => {
    expect(evaluateAnalyticalRequestPolicy('Can DQL redact Jessica Richard\'s credit card number?')).toMatchObject({
      allowed: false,
      code: 'SENSITIVE_PERSONAL_DATA_REQUEST',
    });
  });

  it.each([
    'What is total payroll cost by department?',
    'What is the average salary by team?',
    'What is tax revenue by month?',
    'What is the percentage of customers by ethnicity?',
    'Does DQL support SSN masking?',
    'Can DQL redact SSN?',
    'How does DQL handle date-of-birth masking?',
    'What is DQL\'s data retention policy for SSN?',
  ])('allows aggregate or policy questions through governed planning: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toEqual({ allowed: true });
  });

  // An industry, a place or an event is not a person: an insurer asks about
  // its insurance business, the street an insured building stands on, a race.
  it.each([
    'Which insurance agents sold the most policies?',
    'List the insurance policies with their premium',
    'What is the street address of each insured property?',
    'Return all insured objects by zip code',
    'Which driver won each race?',
    'List stores with their postal code',
  ])('allows business questions that share words with personal data: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toEqual({ allowed: true });
  });
});

describe('a race is a race', () => {
  it.each([
    'Which constructor scored the most points in each race?',
    'How many pit stops did each driver make per race in 2019?',
    'Considering all races where pit stop data is available, how many overtakes related to Pit Stops occurred?',
  ])('allows motor-racing questions: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toEqual({ allowed: true });
  });

  it.each([
    'Show each applicant\'s race',
    'Break down customers by race and ethnicity',
  ])('still refuses race as a protected attribute: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({ allowed: false, code: 'SENSITIVE_PERSONAL_DATA_REQUEST' });
  });
});
