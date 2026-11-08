#!/bin/zsh
# (re)starts a throwaway local demo server for iOS work: own PGlite folder, demo AI, no paid providers, no Twilio
# usage: ios/scripts/demo-server.sh [--reset] [port]
cd ${0:A:h}/../..
RESET=0; [ "${1:-}" = "--reset" ] && { RESET=1; shift; }
PORT=${1:-3107}
pkill -f "next dev --hostname 127.0.0.1 -p $PORT" 2>/dev/null; sleep 2
[ $RESET = 1 ] && rm -rf .data/pglite-ios
RR_DB=pglite RR_PGLITE_DIR=.data/pglite-ios RR_AI=demo RR_EMBED=off ELEVENLABS_API_KEY= TWILIO_ACCOUNT_SID= \
  TWILIO_AUTH_TOKEN= TWILIO_PHONE_NUMBER= DEMO_SMS_TO= GEMINI_API_KEY= SUPABASE_DB_URL= \
  nohup npx next dev --hostname 127.0.0.1 -p $PORT > /tmp/rr-ios-server.log 2>&1 &
for i in $(seq 1 90); do curl -s -m 5 -o /dev/null "http://127.0.0.1:$PORT/api/session" && { echo "server up on $PORT"; exit 0; }; sleep 2; done
echo "server failed to start; see /tmp/rr-ios-server.log"; exit 1
