#!/bin/bash
#
# Run all Custom LLM Server tests.
# Starts each server, runs its tests, then cleans up.
# Servers run on dedicated ports so they don't conflict.
#
# Usage: bash test/run_all.sh [languages...]
#   e.g. bash test/run_all.sh python node go
#   Defaults to all languages.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }

PIDS=()
RESULTS=()

cleanup() {
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    done
}
trap cleanup EXIT

LANGUAGES=("${@:-python node go}")
if [ $# -eq 0 ]; then
    LANGUAGES=(python node go)
fi

wait_for_port() {
    local port="$1"
    local name="$2"
    for i in $(seq 1 30); do
        if curl -s "http://localhost:${port}/" > /dev/null 2>&1; then
            return 0
        fi
        sleep 0.3
    done
    red "$name failed to start on port $port"
    return 1
}

for lang in "${LANGUAGES[@]}"; do
    case "$lang" in
        python)
            echo "Starting Custom LLM Server (Python) on port 8100..."
            cd "$REPO_DIR/python"
            LLM_API_KEY=test-key python3 custom_llm.py > /dev/null 2>&1 &
            PIDS+=($!)
            if wait_for_port 8100 "Python"; then
                echo ""
                if bash "$SCRIPT_DIR/test_python.sh" "http://localhost:8100"; then
                    RESULTS+=("Python: PASSED")
                else
                    RESULTS+=("Python: FAILED")
                fi
            else
                RESULTS+=("Python: FAILED TO START")
            fi
            echo ""
            ;;
        node)
            echo "Starting Custom LLM Server (Node.js) on port 8101..."
            cd "$REPO_DIR/node"
            if [ ! -d "node_modules" ]; then
                npm install --silent 2>/dev/null
            fi
            LLM_API_KEY=test-key node custom_llm.js > /dev/null 2>&1 &
            PIDS+=($!)
            if wait_for_port 8101 "Node.js"; then
                echo ""
                if bash "$SCRIPT_DIR/test_node.sh" "http://localhost:8101"; then
                    RESULTS+=("Node.js: PASSED")
                else
                    RESULTS+=("Node.js: FAILED")
                fi
            else
                RESULTS+=("Node.js: FAILED TO START")
            fi
            echo ""
            ;;
        go)
            echo "Starting Custom LLM Server (Go) on port 8102..."
            cd "$REPO_DIR/go"
            LLM_API_KEY=test-key go run . > /dev/null 2>&1 &
            PIDS+=($!)
            if wait_for_port 8102 "Go"; then
                echo ""
                if bash "$SCRIPT_DIR/test_go.sh" "http://localhost:8102"; then
                    RESULTS+=("Go: PASSED")
                else
                    RESULTS+=("Go: FAILED")
                fi
            else
                RESULTS+=("Go: FAILED TO START")
            fi
            echo ""
            ;;
        *)
            red "Unknown language: $lang"
            ;;
    esac
done

echo "========================================="
echo "Summary"
echo "========================================="
for result in "${RESULTS[@]}"; do
    echo "  $result"
done
