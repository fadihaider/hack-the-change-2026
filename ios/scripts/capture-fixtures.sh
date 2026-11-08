#!/bin/zsh
# drives the demo flow against a local server and saves real JSON responses as XCTest fixtures
# usage: ios/scripts/capture-fixtures.sh [base-url]   (run on a fresh demo database: RR_AI=demo, no Twilio)
set -u
BASE=${1:-http://127.0.0.1:3107}
OUT=${0:A:h}/../ReliefReadyTests/Fixtures
mkdir -p "$OUT"
get() { curl -s -m 60 "$BASE$2" -o "$OUT/$1.json"; echo "GET  $2 -> $1 ($(head -c 80 "$OUT/$1.json"))"; }
post() {
  # next dev answers invalid_origin while a route is still compiling on its first hit, so retry once
  for attempt in 1 2; do
    curl -s -m 90 -X POST "$BASE$2" -H "Origin: $BASE" -H "Content-Type: application/json" -d "$3" -o "$OUT/$1.json"
    grep -q '"invalid_origin"' "$OUT/$1.json" || break
    sleep 2
  done
  echo "POST $2 -> $1 ($(head -c 80 "$OUT/$1.json"))"; }
jqr() { python3 -c "import json,sys; d=json.load(open('$OUT/$1.json')); print(eval('d'+sys.argv[1]))" "$2"; }

get session-empty /api/session
post intake-ready /api/intake '{"statement":"My mom Rosa has hip surgery today and I'"'"'m caring for her until Saturday."}'
post intake-clarify /api/intake '{"statement":"I need help."}'
EPISODE=$(jqr intake-ready "['episodeId']")
get session /api/session
post impact /api/impact "{\"episodeId\":\"$EPISODE\"}"
COMMITMENT=$(python3 -c "
import json; d=json.load(open('$OUT/impact.json'))
c=[c for c in d['commitments'] if c.get('suggestedAction') in ('notify','reschedule','extension','coverage') and (c.get('suggestedContactId') or c.get('suggestedContactIds'))][0]
print(c['id'], c['suggestedAction'], c.get('suggestedContactId') or c['suggestedContactIds'][0])")
set -- ${=COMMITMENT}
post decide /api/commitments/decide "{\"commitmentId\":\"$1\",\"decision\":\"$2\",\"contactId\":\"$3\"}"
OWN=$(python3 -c "
import json; d=json.load(open('$OUT/impact.json'))
print([c['id'] for c in d['commitments'] if c['forCareRecipient']][0])")
post add-to-timeline /api/commitments/timeline "{\"commitmentId\":\"$OWN\"}"
get requests /api/requests
REQ=$(jqr decide "['request']['id']")
post request-edit /api/requests/edit "{\"requestId\":\"$REQ\",\"body\":\"Hi, I need to step away this week for a family matter. Could we sort out a plan? Thanks, Alex\"}"
REV=$(jqr request-edit "['request']['revision']")
curl -s -m 30 -X POST "$BASE/api/requests/approve" -H "Origin: $BASE" -H "Content-Type: application/json" -H "If-Match: \"$REV\"" -d "{\"requestId\":\"$REQ\"}" -o "$OUT/request-approve.json"; echo "approve ($(head -c 80 $OUT/request-approve.json))"
post request-send /api/requests/send "{\"requestId\":\"$REQ\"}"
get request-one "/api/requests/$REQ"
get outbox /api/outbox
TOKEN=$(python3 -c "import json,re; d=json.load(open('$OUT/outbox.json')); m=re.search(r'/r/([A-Za-z0-9_-]{43})', json.dumps(d)); print(m.group(1) if m else '')")
[ -n "$TOKEN" ] && post response-accept "/api/responses/$TOKEN" '{}'
post requests-refresh /api/requests/refresh '{}'
post care-add-note /api/care/sources '{"kind":"note","text":"Rosa wears reading glasses; the spare pair is in the kitchen drawer. She has breakfast at 8:00 and likes the radio on. She lip-reads, so face her when you talk."}'
get care-facts /api/care/facts
FACT=$(python3 -c "
import json; d=json.load(open('$OUT/care-facts.json'))
f=[f for f in d['facts'] if f['status']=='suggested']; print(f[0]['id'] if f else '')")
[ -n "$FACT" ] && post fact-approve "/api/care/facts/$FACT/approve" '{}'
SRC=$(jqr care-add-note "['source']['id']")
get care-source "/api/care/sources/$SRC"
TODAY=$(jqr session "['today']")
get care-timeline "/api/care/timeline?date=$TODAY"
post ask-found /api/care/ask '{"question":"Where are her spare glasses?"}'
post ask-notfound /api/care/ask '{"question":"What is the pharmacy phone number?"}'
post ask-medical /api/care/ask '{"question":"Should I give her more painkillers?"}'
post contact-add /api/care/contacts '{"name":"Aunt Lucia","relationship":"Sister","phone":"403-555-0142","kind":"trusted"}'
get care-contacts /api/care/contacts
get nearby "/api/care-access/nearby?types=pharmacy,clinic,hospital&radiusKm=3&accessible=any"
get care-access-home "/api/care-access/home?threshold=15"
get care-access-basemap /api/care-access/basemap
get care-access-scores "/api/care-access?mode=driving&threshold=15&categories=pharmacy,clinic&stepFree=any&view=scores"
get guide "/api/guide?tenure=yes"
get recover /api/recover
post recover-refresh /api/recover '{}'
get clock /api/clock
get sms-recipients /api/sms/recipients
get sms-list "/api/sms?episodeId=$EPISODE"
post sms-draft /api/sms/draft "{\"episodeId\":\"$EPISODE\",\"recipientName\":\"Lucia\",\"senderName\":\"Alex\",\"tier\":\"minimal\"}"
curl -s -m 30 -X POST "$BASE/api/requests/approve" -H "Origin: $BASE" -H "Content-Type: application/json" -d "{\"requestId\":\"$REQ\"}" -o "$OUT/error-precondition.json"
get error-not-found /api/requests/00000000-0000-0000-0000-000000000000
