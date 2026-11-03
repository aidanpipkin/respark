export const defaults = {
 singleton_key: 'platform', agency_company_id: 'ZqqdNc830ANRYPqW6rmi', owner_email: 'aidan@usnaturalinsurance.com', default_timezone: 'America/Chicago', default_send_windows: { first: '11:00-13:00', second: '17:00-19:00', floor: '09:00', ceiling: '20:00' },
 website_spec_template: `## Home
{{brand_name}} | {{agent_title}}
Talk with {{display_name}} about protection for the people who matter to you. Life insurance options depend on eligibility, carrier and policy terms. No approval, pricing, growth or tax outcome is promised.
CTA: Request information at https://{{domain}}/get-info.
Licensed states: {{licensed_states}}. NPN: {{npn}}.
## Get Info
Collect first name, phone, email, state and product interest. Display an unchecked, optional checkbox separate from submission:
By checking this box, I agree to receive marketing text messages and calls from {{legal_business_name}} ({{brand_name}}) at the phone number provided, including messages sent using automated technology, about life insurance products and services. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. View our Privacy Policy at https://{{domain}}/privacy and SMS Terms at https://{{domain}}/sms-terms.
Do not preselect consent. Store the exact wording, timestamp, source URL and seller name. Do not enroll non-consenting submissions in marketing.
## Privacy Policy
{{legal_business_name}}, {{business_address}}. Questions: {{business_email}} or {{business_phone}}.
Explain collection of contact details, consent records and appointment preferences; use for requested services and follow-up; access controls, retention, correction and deletion requests, and service-provider processing. Mobile opt-in information and text-message consent will not be shared with third parties or affiliates for marketing or promotional purposes. Sharing with service providers solely to deliver this program is permitted. Describe actual analytics/cookies and disclosures before publication. Have counsel review this policy for your actual practices.
## SMS Terms
Program: {{brand_name}} life insurance information and appointment messaging. Frequency varies; message and data rates may apply. Reply STOP to cancel, HELP for assistance, or contact {{business_email}} / {{business_phone}}. Consent is not required to purchase. Carriers are not liable for delayed or undelivered messages. Privacy: https://{{domain}}/privacy.
## Footer
{{legal_business_name}} · {{business_address}} · {{business_phone}} · {{business_email}}
Licensed in {{licensed_states}} · NPN {{npn}}. Privacy | SMS Terms. No sensitive medical details should be submitted by text.`,
 a2p_packet_template: `## Brand fields
Legal name: {{legal_business_name}}
DBA: {{brand_name}}
Address (must match IRS record): {{business_address}}
Email: {{business_email}}
Phone: {{business_phone}}
Website: https://{{domain}}
Enter EIN only in the carrier registration portal. Do not save it in LeadRespark.
## Campaign description
{{brand_name}} sends consent-based life insurance inquiry follow-ups and appointment messages on behalf of {{display_name}}, a licensed life insurance agent. No purchased-list outreach without documented seller-specific consent. Respect STOP immediately and suppress all marketing after opt-out.
## Opt-in flow
Consumers voluntarily enter their phone number at https://{{domain}}/get-info and check the separate, initially unchecked marketing-consent checkbox. Store the exact wording, date/time, source and seller. Disclose automated messaging, variable frequency, message/data rates, optional consent, STOP/HELP and linked Privacy/SMS Terms next to the checkbox. Prior inquiries require independently documented, valid consent naming this seller; an old inquiry alone is not consent.
## STOP response
You are unsubscribed from {{brand_name}} text messages. No more messages will be sent. Configure this acknowledgment in the phone system, not as an AI response.
## HELP response
{{brand_name}}: For help call {{business_phone}} or email {{business_email}}. Msg/data rates may apply. Reply STOP to cancel.
## Sample messages
{{sample_messages}}
## Review before submission
Check brand identity, website accessibility, actual opt-in evidence and all sample messages. Registration approval is not a legal-compliance guarantee.`,
 test_plan_template: `## Preparation
Use only the two verified, consenting test numbers: {{test_phone_numbers}}. Tag both respark-test and record seller-specific consent and timezone. Confirm carrier approval and the texting number {{phone_number}}. Never run this plan against real prospects.
## Opening messages
Send message 1A once to each test contact, substituting their names and {{display_name}} / {{brand_name}}. Confirm delivery and a persistent message-log entry. Confirm quiet hours and the daily cap block disallowed sends.
## Reply cases
YES: stop prospecting follow-ups and create a relevant suggested reply.
1: set family as the discovery priority.
STOP: immediately mark opted out, stop AI and follow-ups, and send no AI reply. A single carrier-managed acknowledgment may occur.
How much is it: no pricing estimate; guide toward a call or human review.
My health isn't great: no medical details or underwriting by text; flag for personal follow-up when appropriate.
## Agent control
Take over: AI and follow-ups pause immediately. Hand back: explicit confirmation, eligibility checks and opt-out protection. Approve/edit/discard a suggested reply and confirm the recorded outcome.
## Calendar and alerts
Book a test call through {{booking_url}}; confirm the correct calendar, contact timezone, rescheduling and cancellation. Verify the agent alert reaches {{alert_mobile}}. Verify daily brief content and quiet hours.
## Isolation and launch
Sign in as a different agent: no contacts, conversations, appointments or branding from this account. Confirm no backend brand names, identifiers, credentials or links appear to the agent. Record evidence for every case before marking live.`
};
export function mergeTemplate(text, settings, extras = {}) {
 const values = { ...settings, ...extras }; return String(text || '').replace(/\{\{([a-z_]+)\}\}/g, (match, key) => Array.isArray(values[key]) ? values[key].join(', ') : String(values[key] ?? `[${key} not provided]`));
}