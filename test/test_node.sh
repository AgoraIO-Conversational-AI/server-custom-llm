#!/bin/bash
#
# Test script for Custom LLM Server (Node.js / Express)
# Tests endpoint availability, error handling, and response format.
# Does NOT require a real LLM API key — tests server structure only.
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

echo "========================================="
echo "Custom LLM Server Tests (Node.js)"
echo "Base URL: $BASE_URL"
echo "========================================="
echo ""

# ===========================================
# HAPPY PATH
# ===========================================

echo "--- Test: Health check ---"
resp=$(curl -s --max-time 5 "${BASE_URL}/ping" || true)
assert_contains "GET /ping returns pong" "$resp" 'pong'
echo ""

echo "--- Test: Root endpoint ---"
resp=$(curl -s --max-time 5 "${BASE_URL}/" || true)
assert_contains "GET / lists endpoints" "$resp" 'chat/completions'
echo ""

echo "--- Test: /chat/completions accepts POST ---"
status=$(curl_status -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true,"model":"gpt-4o-mini"}')
assert_status_oneof "/chat/completions endpoint exists" "$status" "200" "500"
echo ""

echo "--- Test: /rag/chat/completions accepts POST ---"
status=$(curl_status -X POST "${BASE_URL}/rag/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true,"model":"gpt-4o-mini"}')
assert_status_oneof "/rag/chat/completions endpoint exists" "$status" "200" "500"
echo ""

echo "--- Test: /audio/chat/completions accepts POST ---"
status=$(curl_status -X POST "${BASE_URL}/audio/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true,"model":"gpt-4o-mini"}')
assert_status_oneof "/audio/chat/completions endpoint exists" "$status" "200" "500"
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

echo "--- Test: stream=false rejected ---"
status=$(curl_status -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":false,"model":"gpt-4o-mini"}')
assert_status "stream=false returns 400" "$status" "400"
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
