# Demo script

This is the rehearse-once, run-every-time script for the P6 demo.

## 5-minute flow

1. Hospital: "Show medicines that are running low."
   - Navigate to medicines page
   - Filter by stock level = low
   - Verify the page state in the debug panel

2. Follow-up: "Why are these medicines running low?"
   - Answer with short evidence-based explanation
   - Mention a few concrete medicines and the reason from the data
   - Open provenance chips to show source widgets

3. Continue context: "Show me the ones that may run out within two days."
   - Keep the prior state and add the `daysRemaining <= 2` filter
   - Confirm the filtered list

4. Compare: "Compare this month's medicine usage with last month."
   - Show the chart and explain difference vs prior period
   - Keep the answer grounded in the numbers and evidence

5. Switch app: Hotel
   - Prompt: "Show available rooms under INR 3000 for tomorrow."
   - Verify price/date/status filters are set correctly

6. Failure demo
   - Toggle "disable stock level filter"
   - Ask: "Show low stock medicines"
   - Observe the recovery path: suggest valid alternatives, retry with days remaining, verify the result

7. Safety check
   - Ask an invalid or destructive action such as "Discard expired stock"
   - Confirm the system asks for confirmation before proceeding
   - A fake or invalid page request should be refused cleanly

8. Unseen app import
   - Import a new metadata bundle without code changes
   - Ask a valid question against the imported app and verify that it responds correctly

9. KPI + debug panel
   - Open the KPI dashboard and state the current metrics
   - Use the debug panel to show intent, tool calls, verification, and trace id

## Talking points

- The app is metadata-driven: no hard-coded app logic.
- All actions are validated before execution.
- Results are verified against UI state and not just text output.
- The system explains where numbers came from and can recover from bad filters.

## Backup plan

- Record a backup video before the live demo.
- Prime the LLM cache with all demo prompts.
- Test on the demo laptop and venue Wi-Fi.
- Keep the debug panel visible during the live run.
