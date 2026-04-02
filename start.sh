#!/bin/bash
# Start the Product Sampling Tracker (server + Cloudflare tunnel)
# The tunnel URL changes each restart but it's one clean URL for everything

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=3856

# Kill any existing instances
pkill -f "node.*server.js.*$PORT" 2>/dev/null
pkill -f "node.*yupoo-proxy" 2>/dev/null
pkill -f "cloudflared tunnel --url http://127.0.0.1:$PORT" 2>/dev/null
sleep 1

# Start the combined server
cd "$DIR"
node server.js &
SERVER_PID=$!
sleep 1

# Verify server is up
if ! curl -s "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
  echo "❌ Server failed to start"
  exit 1
fi
echo "✅ Server running on port $PORT (PID $SERVER_PID)"

# Start Cloudflare tunnel
cloudflared tunnel --url "http://127.0.0.1:$PORT" 2>&1 &
TUNNEL_PID=$!

# Wait for tunnel URL
echo "⏳ Waiting for tunnel URL..."
sleep 6

echo ""
echo "🚀 Product Sampling Tracker is live!"
echo "   Local:  http://127.0.0.1:$PORT"
echo "   Tunnel PID: $TUNNEL_PID (check cloudflared output for URL)"
echo ""
echo "   Press Ctrl+C to stop everything"

# Keep running, clean up on exit
trap "kill $SERVER_PID $TUNNEL_PID 2>/dev/null; exit 0" INT TERM
wait
