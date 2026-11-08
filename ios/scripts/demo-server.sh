#!/bin/zsh
# (re)starts a throwaway local demo server for iOS work: own PGlite folder, demo AI, no paid providers, no Twilio
# usage: ios/scripts/demo-server.sh [--reset] [--lan] [port]
#   --reset  deletes the demo database first
#   --lan    binds every interface and accepts only http://<mac-ip>:<port>, so a phone on the same wifi works; the
#            default is loopback only, which the simulator reaches as http://127.0.0.1:<port>
# env: RR_IOS_PGLITE_DIR (default .data/pglite-ios), RR_NEXT_DIST_DIR (default .next; give each parallel server its own)
cd ${0:A:h}/../..
RESET=0; LAN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --reset) RESET=1; shift ;;
    --lan) LAN=1; shift ;;
    *) break ;;
  esac
done
PORT=${1:-3200}
DIR=${RR_IOS_PGLITE_DIR:-.data/pglite-ios}
LOG=/tmp/rr-ios-server-$PORT.log
HOST=127.0.0.1; [ $LAN = 1 ] && HOST=0.0.0.0
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)

# stop only this script's own earlier server on the port (either bind), never another worktree's
pkill -f "next dev --hostname (127\.0\.0\.1|0\.0\.0\.0) -p $PORT( |\$)" 2>/dev/null && sleep 2

# anything else still listening here would answer instead of (or next to) this server: a phone reaching the lan
# address talks to a wildcard listener even while a loopback one answers the simulator. refuse rather than guess
OTHERS=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { print $2 " " $9 }' | sort -u)
if [ -n "$OTHERS" ]; then
  echo "port $PORT is already in use by another server, so nothing was started:"
  echo "$OTHERS" | while read -r pid addr; do echo "  pid $pid on $addr: $(ps -o command= -p $pid 2>/dev/null)"; done
  echo "stop it, or pass another port as the last argument"
  exit 1
fi

[ $RESET = 1 ] && rm -rf "$DIR"
# next dev sees every request as its own loopback url, so with APP_BASE_URL blank a lan Origin fails checkOrigin
# (app/api/_lib/http.ts). lan mode therefore makes the lan address the one accepted origin: the phone, and the
# simulator too, must then use http://<mac-ip>:<port>. paid providers stay off, so RR_TRUSTED_LAN_HOSTS stays blank
BASE=; DEV_ORIGINS=
if [ $LAN = 1 ]; then
  [ -z "$LAN_IP" ] && { echo "no wifi address found for --lan"; exit 1; }
  BASE=http://$LAN_IP:$PORT; DEV_ORIGINS=$LAN_IP
fi
RR_DB=pglite RR_PGLITE_DIR="$DIR" RR_AI=demo RR_EMBED=off ELEVENLABS_API_KEY= TWILIO_ACCOUNT_SID= \
  TWILIO_AUTH_TOKEN= TWILIO_PHONE_NUMBER= DEMO_SMS_TO= GEMINI_API_KEY= SUPABASE_DB_URL= APP_BASE_URL="$BASE" \
  RR_DEV_ORIGINS="$DEV_ORIGINS" RR_TRUSTED_LAN_HOSTS= RR_NEXT_DIST_DIR="${RR_NEXT_DIST_DIR:-.next}" \
  nohup npx next dev --hostname $HOST -p $PORT > "$LOG" 2>&1 &
for i in $(seq 1 90); do
  if curl -s -m 5 -o /dev/null "http://127.0.0.1:$PORT/api/session"; then
    echo "server up on http://127.0.0.1:$PORT"
    [ $LAN = 1 ] && echo "lan mode: point the phone and the simulator at $BASE (the only accepted origin)"
    exit 0
  fi
  sleep 2
done
echo "server failed to start; see $LOG"; exit 1
