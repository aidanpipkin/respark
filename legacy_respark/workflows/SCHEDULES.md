# Cron schedules to recreate (pg_cron or Supabase scheduled functions)

| Workflow | Cron (America/Chicago) | Function | Notes |
|---|---|---|---|
| Approval Recovery Drip | `*/15 * * * *` | approvalRecovery | Every 15 minutes: auto-enrolls any open opportunity sitting in a "Lost at Banking" stage,  |
| Closed Client Guard | `7,37 * * * *` | closedGuard | Every 30 min: finds every GHL opportunity in a Closed / App Submitted / Policy Issued stag |
| Daily Appointment Summary | `0 8 * * 1-6` | sendAppointmentSummary, resparkReport, LLM agent step (port to Claude) | 8am CT Mon-Sat: one iMessage brief for Aidan with today's booked calls plus the Respark te |
| Daily Calling List | `0 7 * * 1-6` | sendCallingList, LLM agent step (port to Claude) | Sends a prioritized calling list email at 7am CT every weekday. Lists 200 GHL-synced leads |
| GOAT Lead Follow-up Texts | `*/5 * * * *` | goatLeadFollowup | Every 5 minutes: runs the GOAT fresh-lead text sequence. Detects replies (sends the calend |
| Respark Appointment Flow | `*/5 * * * *` | resparkAppointmentFlow | Every 5 minutes: for booked Respark leads, sends the lead's reminder texts (24h "reply yes |
| Respark Enroller | `*/30 7-21 * * 1-6` | resparkEnroll | Every 30 minutes (7am-9pm CT, Mon-Sat): enrolls New Lead trucker opportunities into the 30 |
| Respark Reply Monitor | `*/5 * * * *` | aidanReply | Every 5 minutes: the Respark reply bot (speaking as Aidan) answers new inbound texts from  |
| Respark Sender | `*/5 8-21 * * *` | resparkSend | Every 5 minutes (8am-9:55pm CT, every day): sends the next due Respark text to each active |
| Respark Test Monitor (Aidan only) | `*/5 * * * *` | aidanReply | TEST ONLY: every 5 minutes the Respark reply bot checks Aidan's own GHL contact (hLZmFD5Az |
| Riley Closed Client Guard | `9,39 * * * *` | rileyClosedGuard | Every 30 minutes: HARD RULE, never text a closed client. Scans every Closed/Sold stage acr |
| Riley Respark Appointment Flow | `2-57/5 * * * *` | rileyAppointmentFlow | Every 5 minutes: light-touch reminders to Riley's booked leads (day-before text + branded  |
| Riley Respark Enroller | `1-56/5 * * * *` | rileyEnroll | Every 5 minutes: enrolls New Lead trucker opportunities from Riley's two Respark pipelines |
| Riley Respark Reply Monitor | `1-56/5 * * * *` | rileyReply | Every 5 minutes: answers inbound texts from Riley's Respark leads as Riley, books calls on |
| Riley Respark Sender | `*/5 * * * *` | rileySend | Every 5 minutes: sends the next due Respark sequence text to Riley's active leads inside t |
