package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"log/slog"
	"strings"
)

// RAGData contains sample knowledge base entries for retrieval.
var RAGData = map[string]string{
	"agora_convoai": "Agora Conversational AI enables real-time voice and video AI agents. " +
		"It connects to LLM providers through a Custom LLM server, supports " +
		"tool calling, and provides sub-second voice interactions. Agents join " +
		"Agora RTC channels and communicate with users via voice, video, or text.",
	"custom_llm": "A Custom LLM server intercepts requests between Agora ConvoAI and your " +
		"LLM provider. It receives OpenAI-compatible chat completion requests, " +
		"can modify messages, inject RAG context, execute tools server-side, " +
		"and route to different models. Responses stream back as Server-Sent Events.",
	"agora_rtm": "Agora Real-Time Messaging (RTM) provides low-latency text messaging " +
		"between users and AI agents. RTM channels allow the Custom LLM server " +
		"to receive and send text messages alongside voice/video interactions.",
	"tool_calling": "Tool calling lets LLMs invoke external functions during a conversation. " +
		"The model returns a tool_calls response, the server executes the function, " +
		"and sends the result back to the model for a final answer. This enables " +
		"weather lookups, calculations, database queries, and more.",
}

// ToolDefinition represents an OpenAI-compatible tool schema.
type ToolDefinition struct {
	Type     string         `json:"type"`
	Function ToolFunctionDef `json:"function"`
}

// ToolFunctionDef represents the function part of a tool definition.
type ToolFunctionDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// ToolHandler is the signature for tool implementation functions.
type ToolHandler func(appID, userID, channel string, args map[string]any) string

// GetToolDefinitions returns the list of available tool schemas.
func GetToolDefinitions() []ToolDefinition {
	return []ToolDefinition{
		{
			Type: "function",
			Function: ToolFunctionDef{
				Name:        "get_weather",
				Description: "Get the current weather for a given location",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"location": map[string]any{
							"type":        "string",
							"description": "City name, e.g. 'Tokyo' or 'San Francisco'",
						},
					},
					"required": []string{"location"},
				},
			},
		},
		{
			Type: "function",
			Function: ToolFunctionDef{
				Name:        "calculate",
				Description: "Evaluate a mathematical expression and return the result",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"expression": map[string]any{
							"type":        "string",
							"description": "Math expression to evaluate, e.g. '42 * 17'",
						},
					},
					"required": []string{"expression"},
				},
			},
		},
	}
}

// ToolMap maps tool names to their handler functions.
var ToolMap = map[string]ToolHandler{
	"get_weather": getWeather,
	"calculate":   calculateTool,
}

func getWeather(appID, userID, channel string, args map[string]any) string {
	location, _ := args["location"].(string)
	if location == "" {
		location = "Unknown"
	}
	slog.Info("get_weather called", "location", location)
	return fmt.Sprintf("Weather in %s: 72°F (22°C), partly cloudy, humidity 45%%", location)
}

func calculateTool(appID, userID, channel string, args map[string]any) string {
	expression, _ := args["expression"].(string)
	if expression == "" {
		expression = "0"
	}
	slog.Info("calculate called", "expression", expression)

	// Safe evaluation using Go's AST parser for basic arithmetic
	result, err := safeEval(expression)
	if err != nil {
		return fmt.Sprintf("Error evaluating '%s': %v", expression, err)
	}
	return fmt.Sprintf("Result: %v", result)
}

// safeEval evaluates simple arithmetic expressions safely using Go's AST parser.
func safeEval(expr string) (float64, error) {
	fset := token.NewFileSet()
	node, err := parser.ParseExpr(expr)
	if err != nil {
		return 0, fmt.Errorf("parse error: %w", err)
	}
	return evalNode(fset, node)
}

func evalNode(fset *token.FileSet, node ast.Expr) (float64, error) {
	switch n := node.(type) {
	case *ast.BasicLit:
		var val float64
		_, err := fmt.Sscanf(n.Value, "%f", &val)
		if err != nil {
			_, err = fmt.Sscanf(n.Value, "%e", &val)
		}
		return val, err
	case *ast.ParenExpr:
		return evalNode(fset, n.X)
	case *ast.UnaryExpr:
		x, err := evalNode(fset, n.X)
		if err != nil {
			return 0, err
		}
		if n.Op == token.SUB {
			return -x, nil
		}
		return x, nil
	case *ast.BinaryExpr:
		left, err := evalNode(fset, n.X)
		if err != nil {
			return 0, err
		}
		right, err := evalNode(fset, n.Y)
		if err != nil {
			return 0, err
		}
		switch n.Op {
		case token.ADD:
			return left + right, nil
		case token.SUB:
			return left - right, nil
		case token.MUL:
			return left * right, nil
		case token.QUO:
			if right == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			return left / right, nil
		case token.REM:
			if right == 0 {
				return 0, fmt.Errorf("modulo by zero")
			}
			return float64(int64(left) % int64(right)), nil
		default:
			return 0, fmt.Errorf("unsupported operator: %s", n.Op)
		}
	default:
		return 0, fmt.Errorf("unsupported expression type: %T", node)
	}
}

// PerformRAGRetrieval does keyword-based retrieval from RAGData.
func PerformRAGRetrieval(messages []Message) string {
	var query string

	// Find the last user message
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			if content, ok := messages[i].Content.(string); ok {
				query = strings.ToLower(content)
			}
			break
		}
	}

	if query == "" {
		return ""
	}

	words := strings.Fields(query)
	var keywords []string
	for _, w := range words {
		if len(w) > 3 {
			keywords = append(keywords, w)
		}
	}
	if len(keywords) == 0 {
		return ""
	}

	var relevant []string
	for _, value := range RAGData {
		valueLower := strings.ToLower(value)
		for _, keyword := range keywords {
			if strings.Contains(valueLower, keyword) {
				relevant = append(relevant, value)
				break
			}
		}
	}

	if len(relevant) == 0 {
		return "No relevant information found."
	}
	return strings.Join(relevant, "\n\n")
}

// RefactMessages injects RAG context as a system message.
func RefactMessages(context string, messages []Message) []Message {
	if context == "" || context == "No relevant information found." {
		return messages
	}

	contextMsg := Message{
		Role:    "system",
		Content: fmt.Sprintf("Use this knowledge to answer the user's question:\n%s", context),
	}

	result := make([]Message, 0, len(messages)+1)
	result = append(result, contextMsg)
	result = append(result, messages...)
	return result
}
