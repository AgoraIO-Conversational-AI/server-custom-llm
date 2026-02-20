#!/bin/bash
#
# Test script for Custom LLM Server (Node.js / Express)
# Tests endpoint availability, SSE format, conversation memory, RAG,
# and error handling. Does NOT require a real LLM API key.
#
# Usage: bash test_node.sh [base_url]
#   base_url defaults to http://localhost:8101

set -euo pipefail

BASE_URL="${1:-http://localhost:8101}"
PASS=0
FAIL=0

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }

assert_status() {
    local test_name="$1"
    local actual="$2"
    local expected="$3"
    if [ "$actual" = "$expected" ]; then
        green "PASS: $test_name"
        PASS=$((PASS + 1))
    else
        red "FAIL: $test_name"
        echo "  Expected status: $expected"
        echo "  Got: $actual"
        FAIL=$((FAIL + 1))
    fi
}

assert_status_oneof() {
    local test_name="$1"
    local actual="$2"
    shift 2
    for expected in "$@"; do
        if [ "$actual" = "$expected" ]; then
            green "PASS: $test_name (status $actual)"
            PASS=$((PASS + 1))
            return
        fi
    done
    red "FAIL: $test_name"
    echo "  Expected one of: $*"
    echo "  Got: $actual"
    FAIL=$((FAIL + 1))
}

assert_contains() {
    local test_name="$1"
    local response="$2"
    local expected="$3"
    if echo "$response" | grep -qiF "$expected"; then
        green "PASS: $test_name"
        PASS=$((PASS + 1))
    else
        red "FAIL: $test_name"
        echo "  Expected to contain: $expected"
        echo "  Got: $(echo "$response" | head -5)"
        FAIL=$((FAIL + 1))
    fi
}

# Curl wrapper that tolerates timeout (exit 28) for SSE streams.
curl_status() {
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$@") || true
    echo "$status"
}

# Curl wrapper that returns response body.
curl_body() {
    curl -s --max-time 5 "$@" || true
}

echo "========================================="
echo "Custom LLM Server Tests (Node.js)"
echo "Base URL: $BASE_URL"
echo "========================================="
echo ""

# ===========================================
# HAPPY PATH
# ===========================================

echo "--- Test: Health check ---"
resp=$(curl_body "${BASE_URL}/ping")
assert_contains "GET /ping returns pong" "$resp" 'pong'
echo ""

echo "--- Test: Root endpoint ---"
resp=$(curl_body "${BASE_URL}/")
assert_contains "GET / lists endpoints" "$resp" 'chat/completions'
echo ""

echo "--- Test: /chat/completions streaming accepts POST ---"
status=$(curl_status -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true,"model":"gpt-4o-mini"}')
assert_status_oneof "/chat/completions streaming accepted" "$status" "200" "500"
echo ""

echo "--- Test: /chat/completions streaming returns SSE content-type ---"
ct=$(curl -s -o /dev/null -w "%{content_type}" --max-time 5 -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true,"model":"gpt-4o-mini"}' || true)
assert_contains "/chat/completions returns text/event-stream" "$ct" "text/event-stream"
echo ""

echo "--- Test: /chat/completions non-streaming accepts POST ---"
status=$(curl_status -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":false,"model":"gpt-4o-mini"}')
assert_status_oneof "/chat/completions non-streaming accepted" "$status" "200" "500"
echo ""

echo "--- Test: /chat/completions with context ---"
status=$(curl_status -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true,"model":"gpt-4o-mini","context":{"appId":"test-app","userId":"test-user","channel":"test-channel"}}')
assert_status_oneof "/chat/completions with context accepted" "$status" "200" "500"
echo ""

echo "--- Test: /chat/completions with tools ---"
status=$(curl_status -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"What is the weather?"}],"stream":true,"model":"gpt-4o-mini","tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"location":{"type":"string"}},"required":["location"]}}}]}')
assert_status_oneof "/chat/completions with tools accepted" "$status" "200" "500"
echo ""

echo "--- Test: /rag/chat/completions accepts POST ---"
status=$(curl_status -X POST "${BASE_URL}/rag/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Tell me about Agora ConvoAI"}],"stream":true,"model":"gpt-4o-mini"}')
assert_status_oneof "/rag/chat/completions accepted" "$status" "200" "500"
echo ""

echo "--- Test: /rag/chat/completions returns waiting message ---"
resp=$(curl_body -X POST "${BASE_URL}/rag/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Tell me about Agora ConvoAI"}],"stream":true,"model":"gpt-4o-mini"}')
assert_contains "RAG response contains waiting_msg" "$resp" "waiting_msg"
echo ""

echo "--- Test: /rag/chat/completions returns SSE content-type ---"
ct=$(curl -s -o /dev/null -w "%{content_type}" --max-time 5 -X POST "${BASE_URL}/rag/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Tell me about Agora ConvoAI"}],"stream":true,"model":"gpt-4o-mini"}' || true)
assert_contains "/rag/chat/completions returns text/event-stream" "$ct" "text/event-stream"
echo ""

echo "--- Test: /audio/chat/completions accepts POST ---"
status=$(curl_status -X POST "${BASE_URL}/audio/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true,"model":"gpt-4o-mini"}')
assert_status_oneof "/audio/chat/completions accepted" "$status" "200" "500"
echo ""

echo "--- Test: /audio/chat/completions returns SSE data ---"
resp=$(curl_body -X POST "${BASE_URL}/audio/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true,"model":"gpt-4o-mini"}')
assert_contains "Audio response contains SSE data" "$resp" "data:"
echo ""

echo "--- Test: /chat/completions with empty context ---"
status=$(curl_status -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true,"model":"gpt-4o-mini","context":{}}')
assert_status_oneof "/chat/completions with empty context accepted" "$status" "200" "500"
echo ""

# ===========================================
# FAILURE PATH
# ===========================================

echo "--- Test: Missing messages field ---"
status=$(curl_status -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"stream":true,"model":"gpt-4o-mini"}')
assert_status "Missing messages returns 400" "$status" "400"
echo ""

echo "--- Test: RAG stream=false rejected ---"
status=$(curl_status -X POST "${BASE_URL}/rag/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":false,"model":"gpt-4o-mini"}')
assert_status "RAG stream=false returns 400" "$status" "400"
echo ""

echo "--- Test: Audio stream=false rejected ---"
status=$(curl_status -X POST "${BASE_URL}/audio/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":false,"model":"gpt-4o-mini"}')
assert_status "Audio stream=false returns 400" "$status" "400"
echo ""

echo "--- Test: RAG missing messages ---"
status=$(curl_status -X POST "${BASE_URL}/rag/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"stream":true,"model":"gpt-4o-mini"}')
assert_status "RAG missing messages returns 400" "$status" "400"
echo ""

echo "--- Test: Non-existent endpoint ---"
status=$(curl_status -X POST "${BASE_URL}/nonexistent")
assert_status "Non-existent endpoint returns 404" "$status" "404"
echo ""

# --- Summary ---
echo "========================================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then
    red "$FAIL test(s) FAILED"
    exit 1
else
    green "All tests passed!"
    exit 0
fi
