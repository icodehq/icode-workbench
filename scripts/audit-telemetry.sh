#!/usr/bin/env bash
# Fails if an analytics or telemetry SDK or endpoint is added to iCode.
#
# Allowed network calls:
#   - electron-updater's update check to GitHub Releases
#   - the agent CLIs and providers the user configured
#   - the git remotes the user configured
#
# Run locally: bash scripts/audit-telemetry.sh
# CI: .github/workflows/telemetry-audit.yml

set -euo pipefail
cd "$(dirname "$0")/.."

package_hits=$(grep -nE '"(posthog[^"]*|@sentry/[^"]*|sentry[^"]*|amplitude[^"]*|mixpanel[^"]*|@segment/[^"]*|segment-analytics[^"]*|analytics-node[^"]*|plausible[^"]*|umami[^"]*|bugsnag[^"]*|datadog[^"]*|newrelic[^"]*|google-analytics[^"]*|gtag[^"]*|matomo[^"]*|fullstory[^"]*|logrocket[^"]*|smartlook[^"]*|hotjar[^"]*|rudderstack[^"]*|snowplow[^"]*|countly[^"]*|appsflyer[^"]*|firebase-analytics[^"]*)"' package.json || true)

source_hits=$(grep -RInE '(posthog\.com|posthog-js|@sentry/|sentry\.io|amplitude\.com|mixpanel\.com|@segment/|segment\.io|plausible\.io|umami\.is|bugsnag\.com|datadoghq\.com|newrelic\.com|google-analytics\.com|googletagmanager\.com|matomo\.cloud|fullstory\.com|logrocket\.com|hotjar\.com|clarity\.ms|rudderstack\.com|snowplow\.io|countly\.io|appsflyer\.com|firebase-analytics)' src \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' \
  --exclude='*.test.ts' --exclude='*.test.tsx' --exclude='*.spec.ts' 2>/dev/null || true)

if [ -n "$package_hits" ]; then
  echo "FAIL: analytics dependency in package.json"
  echo "$package_hits"
  exit 1
fi

if [ -n "$source_hits" ]; then
  echo "FAIL: analytics SDK or endpoint in src/"
  echo "$source_hits"
  exit 1
fi

echo "PASS: no analytics dependencies or endpoints in src/ or package.json."
