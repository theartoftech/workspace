# Sprint 6 human acceptance script

Run this only after the reviewed `pods/log` RBAC rule has been applied separately, the Sprint 6 candidate has been explicitly deployed, and `deploy-lab-docker.sh verify` passes. Do not paste log contents, tokens, credentials, or downloaded diagnostic bundles into tickets, chat, screenshots, or Git.

## Preconditions

1. Confirm the portal is the expected candidate at `https://monitor.jefferyhaynes.net`.
2. Confirm the global banner reports live or honestly partial server APIs.
3. Select **Shared (all)** and **Last 1 hour**.
4. Open browser developer tools and clear existing console errors.

## A. Failed-service and incident deep links

1. Open a service detail page and select **Investigate logs**.
2. Verify **Logs & events** opens with the same service and **Last 1 hour** still selected.
3. Return to **Incidents**, select an incident, and choose **Investigate logs**.
4. Verify the incident's service is selected without rebuilding the time range.
5. Open **Performance**, select a specific service, and use **View correlated logs** in its correlation panel.

Expected: all three paths preserve service/time context and open the same bounded workspace.

## B. Live logs and events

1. Select a service with a Kubernetes workload, such as CPQ Demo, CPQ Test, OAuth / Keycloak, Mailpit, or Portfolio.
2. Verify the source cards independently report `kubernetes pod logs` and `kubernetes events`.
3. Verify the page lists mapped pods, bounded log lines, and relevant timestamped events, or gives an explicit no-data reason.
4. Select a specific pod, then filter severity to **Error**.
5. Search for a harmless visible term from a returned line.
6. If a visible correlation ID exists, paste it into **Correlation ID** and apply.

Expected: filters narrow results; missing matches say no lines matched and do not imply zero activity. The page declares an 8-pod, 16-stream, 500-line, 5-event-per-object, and 50-event-overall maximum.

## C. Redaction and diagnostic bundle

1. Verify the page displays **Server-side redaction applied** and `[REDACTED]` as the replacement.
2. Confirm no authorization header, bearer value, Kubernetes token, cookie, password, sensitive URL userinfo, or secret query value appears in the browser response or UI.
3. Select **Download diagnostic JSON**.
4. Inspect the downloaded file locally without sharing it.
5. Verify it declares `sourcePolicy: server-redacted` and includes sources, omissions, limits, truncation, and redaction metadata.
6. Verify raw message-search and correlation-filter values are not echoed into the evidence envelope; only applied flags are present.

Expected: the export contains only the bounded, already-redacted response and accurately declares missing sources.

## D. Partial and edge states

1. Select ERPNext, which currently has no catalog Kubernetes workload mapping.
2. Verify the page explicitly reports unavailable workload evidence and does not show a false successful log source.
3. Enter a search term that cannot occur and apply it.
4. Clear the search and switch among 15 minutes, 1 hour, 6 hours, and 24 hours.
5. Refresh the browser on a `/logs?service=...&range=...` deep link.

Expected: no mapping, no matches, range changes, reload, and partial evidence all remain explicit and usable.

## E. Regression and accessibility

1. Use keyboard navigation through every log filter, **Apply filters**, **Download diagnostic JSON**, and the left rail.
2. Verify visible focus, labels, and screen-reader names for every control.
3. Press `/` outside an input and confirm command search still opens and finds **Logs** and **Portfolio**.
4. Visit Overview, Performance, Infrastructure, Incidents, and a service detail page.
5. Confirm no page was broken by a log-source failure and no application console errors appeared.

## Acceptance record

Record only pass/fail, candidate commit, time, selected services/ranges, any explicit omission messages, and browser/OS versions. Do not record raw log lines or diagnostic bundle contents.
