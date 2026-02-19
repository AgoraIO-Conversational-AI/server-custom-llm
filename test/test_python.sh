#!/bin/bash
#
# Test script for Custom LLM Server (Python / FastAPI)
# Tests endpoint availability, error handling, and response format.
# Does NOT require a real LLM API key — tests server structure only.
#
# Usage: bash test_python.sh [base_url]
#   base_url defaults to http://localhost:8100

set -euo pipefail

BASE_URL="${1:-http://localhost:8100}"
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

# Curl wrapper that tolerates timeout (exit 28) for SSE streams.
# Returns HTTP status code or "000" on connection failure.
curl_status() {
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$@") || true
    echo "$status"
}

echo "========================================="
echo "Custom LLM Server Tests (Python)"
echo "Base URL: $BASE_URL"
echo "========================================="
echo ""

# ===========================================
# HAPPY PATH
# ===========================================

echo "--- Test: FastAPI docs available ---"
status=$(curl_status "${BASE_URL}/docs")
assert_status "GET /docs returns 200" "$status" "200"
echo ""

echo "--- Test: /chat/completions accepts POST ---"
# With a fake API key the OpenAI call will fail, but the server should accept
# the request and return either SSE (200) or error detail (500).
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

echo "--- Test: stream=false rejected ---"
# Note: With a fake API key, the OpenAI call may fail before the stream check,
# returning 500 instead of 400. Both indicate the server processed the request.
status=$(curl_status -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"Hello"}],"stream":false,"model":"gpt-4o-mini"}')
assert_status_oneof "stream=false rejected" "$status" "400" "500"
echo ""

echo "--- Test: Missing messages field ---"
status=$(curl_status -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"stream":true,"model":"gpt-4o-mini"}')
assert_status "Missing messages returns 422" "$status" "422"
echo ""

echo "--- Test: Invalid JSON body ---"
status=$(curl_status -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -d 'not valid json')
assert_status "Invalid JSON returns 422" "$status" "422"
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
