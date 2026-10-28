## Link this repository

**PagerDuty: Link Repo to Service** writes a `.pagerduty.json` at the repo root:

```json
{ "serviceId": "PXXXXXX", "paths": ["services/payments/**"] }
```

The status bar then shows who's on call for the service. Incidents get the commits made shortly before they triggered, and the files their stack traces point to.
