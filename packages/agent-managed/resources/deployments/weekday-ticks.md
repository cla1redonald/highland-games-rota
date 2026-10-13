---
{
  "name": "Ghillie weekday ticks",
  "agent": "../agents/ghillie.md",
  "environment_id": "../environments/ghillie.yaml",
  "schedule": {
    "type": "cron",
    "expression": "0 13,18 * * 1-5",
    "timezone": "Europe/London"
  },
  "budget": {
    "type": "limit",
    "max_list_cost": {
      "amount": "200",
      "currency": "USD"
    }
  }
}
---

Scheduled tick. Call gather_evidence first: it returns this tick's brief, with the evidence and the logRun fields. Then work through the tick exactly as your instructions say.
