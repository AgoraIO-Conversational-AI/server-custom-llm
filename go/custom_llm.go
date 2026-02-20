package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/sashabaranov/go-openai"
)

type (
	AudioContent struct {
		InputAudio map[string]string `json:"input_audio"`
		Type       string            `json:"type"`
	}

	ChatCompletionRequest struct {
		Audio             map[string]string `json:"audio,omitempty"`
		Context           map[string]any    `json:"context,omitempty"`
		Messages          []Message         `json:"messages"`
		Modalities        []string          `json:"modalities"`
		Model             string            `json:"model,omitempty"`
		ParallelToolCalls bool              `json:"parallel_tool_calls"`
		ResponseFormat    *ResponseFormat   `json:"response_format,omitempty"`
		Stream            bool              `json:"stream"`
		StreamOptions     map[string]any    `json:"stream_options,omitempty"`
		ToolChoice        any               `json:"tool_choice,omitempty"`
		Tools             []Tool            `json:"tools,omitempty"`
	}

	ImageContent struct {
		ImageURL string `json:"image_url"`
		Type     string `json:"type"`
	}

	Message struct {
		Audio      map[string]string `json:"audio,omitempty"`
		Content    any               `json:"content"`
		Name       string            `json:"name,omitempty"`
		Role       string            `json:"role"`
		ToolCallID string            `json:"tool_call_id,omitempty"`
		ToolCalls  []map[string]any  `json:"tool_calls,omitempty"`
	}

	ResponseFormat struct {
		JSONSchema map[string]string `json:"json_schema,omitempty"`
		Type       string            `json:"type"`
	}

	TextContent struct {
		Text string `json:"text"`
		Type string `json:"type"`
	}

	Tool struct {
		Function ToolFunction `json:"function"`
		Type     string       `json:"type"`
	}

	ToolChoice struct {
		Function map[string]any `json:"function,omitempty"`
		Type     string         `json:"type"`
	}

	ToolFunction struct {
		Description string         `json:"description,omitempty"`
		Name        string         `json:"name"`
		Parameters  map[string]any `json:"parameters,omitempty"`
		Strict      bool           `json:"strict"`
	}
)

var waitingMessages = []string{
	"Just a moment, I'm thinking...",
	"Let me think about that for a second...",
	"Good question, let me find out...",
}

// Server represents the chat completion server.
type Server struct {
	client    *openai.Client
	logger    *slog.Logger
	convStore *ConversationStore
	model     string
}

// NewServer creates a new server instance.
func NewServer(apiKey, baseURL, model string) *Server {
	config := openai.DefaultConfig(apiKey)
	if baseURL != "" && baseURL != "https://api.openai.com/v1" {
		config.BaseURL = baseURL
	}
	return &Server{
		client:    openai.NewClientWithConfig(config),
		logger:    slog.New(slog.NewJSONHandler(os.Stdout, nil)),
		convStore: NewConversationStore(),
		model:     model,
	}
}

// extractContext gets appId, userId, channel from the request context.
func extractContext(request ChatCompletionRequest) (string, string, string) {
	ctx := request.Context
	if ctx == nil {
		return "", "", "default"
	}
	appID, _ := ctx["appId"].(string)
	userID, _ := ctx["userId"].(string)
	channel, _ := ctx["channel"].(string)
	if channel == "" {
		channel = "default"
	}
	return appID, userID, channel
}

// messagesToOpenAI converts our Message type to the go-openai library format.
func messagesToOpenAI(messages []Message) []openai.ChatCompletionMessage {
	result := make([]openai.ChatCompletionMessage, 0, len(messages))
	for _, msg := range messages {
		oaiMsg := openai.ChatCompletionMessage{
			Role: msg.Role,
		}

		if strContent, ok := msg.Content.(string); ok {
			oaiMsg.Content = strContent
		} else if msg.Content != nil {
			b, _ := json.Marshal(msg.Content)
			oaiMsg.Content = string(b)
		}

		if msg.ToolCallID != "" {
			oaiMsg.ToolCallID = msg.ToolCallID
		}
		if msg.Name != "" {
			oaiMsg.Name = msg.Name
		}

		// Convert tool_calls
		if len(msg.ToolCalls) > 0 {
			for _, tc := range msg.ToolCalls {
				oaiTC := openai.ToolCall{
					Type: openai.ToolTypeFunction,
				}
				if id, ok := tc["id"].(string); ok {
					oaiTC.ID = id
				}
				if fn, ok := tc["function"].(map[string]any); ok {
					if name, ok := fn["name"].(string); ok {
						oaiTC.Function.Name = name
					}
					if args, ok := fn["arguments"].(string); ok {
						oaiTC.Function.Arguments = args
					}
				}
				oaiMsg.ToolCalls = append(oaiMsg.ToolCalls, oaiTC)
			}
		}

		result = append(result, oaiMsg)
	}
	return result
}

// toolsToOpenAI converts our Tool type to the go-openai library format.
func toolsToOpenAI(tools []Tool) []openai.Tool {
	if len(tools) == 0 {
		return nil
	}
	result := make([]openai.Tool, len(tools))
	for i, tool := range tools {
		result[i] = openai.Tool{
			Type: openai.ToolTypeFunction,
			Function: &openai.FunctionDefinition{
				Name:        tool.Function.Name,
				Description: tool.Function.Description,
				Parameters:  tool.Function.Parameters,
			},
		}
	}
	return result
}

// getToolsForRequest returns tool definitions — request tools if provided, else built-in.
func getToolsForRequest(requestTools []Tool) []openai.Tool {
	if len(requestTools) > 0 {
		return toolsToOpenAI(requestTools)
	}
	// Use built-in tool definitions
	defs := GetToolDefinitions()
	result := make([]openai.Tool, len(defs))
	for i, def := range defs {
		result[i] = openai.Tool{
			Type: openai.ToolTypeFunction,
			Function: &openai.FunctionDefinition{
				Name:        def.Function.Name,
				Description: def.Function.Description,
				Parameters:  def.Function.Parameters,
			},
		}
	}
	return result
}

// buildMessagesWithHistory merges conversation history with incoming messages.
func (s *Server) buildMessagesWithHistory(appID, userID, channel string, requestMessages []Message) []Message {
	history := s.convStore.GetMessages(appID, userID, channel)
	incoming := requestMessages

	// Save incoming user messages
	for _, msg := range incoming {
		if msg.Role == "user" {
			content, _ := msg.Content.(string)
			s.convStore.SaveMessage(appID, userID, channel, ConversationMessage{
				Role:    "user",
				Content: content,
			})
		}
	}

	// Convert history to Messages
	var historyMsgs []Message
	for _, cm := range history {
		m := Message{
			Role:    cm.Role,
			Content: cm.Content,
		}
		if cm.ToolCallID != "" {
			m.ToolCallID = cm.ToolCallID
		}
		if cm.Name != "" {
			m.Name = cm.Name
		}
		if len(cm.ToolCalls) > 0 {
			m.ToolCalls = cm.ToolCalls
		}
		historyMsgs = append(historyMsgs, m)
	}

	return append(historyMsgs, incoming...)
}

// executeTools runs tool calls and returns tool result messages.
func executeTools(toolCalls []openai.ToolCall, appID, userID, channel string) []Message {
	var results []Message
	for _, tc := range toolCalls {
		name := tc.Function.Name
		argsStr := tc.Function.Arguments

		fn, ok := ToolMap[name]
		if !ok {
			slog.Error("Unknown tool", "name", name)
			results = append(results, Message{
				Role:       "tool",
				ToolCallID: tc.ID,
				Name:       name,
				Content:    fmt.Sprintf("Error: unknown tool '%s'", name),
			})
			continue
		}

		var args map[string]any
		if err := json.Unmarshal([]byte(argsStr), &args); err != nil {
			args = map[string]any{}
		}

		result := fn(appID, userID, channel, args)
		results = append(results, Message{
			Role:       "tool",
			ToolCallID: tc.ID,
			Name:       name,
			Content:    result,
		})
	}
	return results
}

// toolCallsToMapSlice converts openai.ToolCall slice to our map format for storage.
func toolCallsToMapSlice(toolCalls []openai.ToolCall) []map[string]any {
	var result []map[string]any
	for _, tc := range toolCalls {
		result = append(result, map[string]any{
			"id":   tc.ID,
			"type": "function",
			"function": map[string]any{
				"name":      tc.Function.Name,
				"arguments": tc.Function.Arguments,
			},
		})
	}
	return result
}

// handleAudioChatCompletion handles the audio chat completion endpoint.
func (s *Server) handleAudioChatCompletion(c *gin.Context) {
	var request ChatCompletionRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		s.sendError(c, http.StatusBadRequest, err)
		return
	}

	if !request.Stream {
		s.sendError(c, http.StatusBadRequest, fmt.Errorf("chat completions require streaming"))
		return
	}

	c.Header("Content-Type", "text/event-stream")

	textContent, err := s.readTextFile("./file.txt")
	if err != nil {
		s.logger.Error("Failed to read text file", "err", err)
		s.sendError(c, http.StatusInternalServerError, err)
		return
	}

	sampleRate := 16000
	durationMs := 40
	audioChunks, err := s.readPCMFile("./file.pcm", sampleRate, durationMs)
	if err != nil {
		s.logger.Error("Failed to read PCM file", "err", err)
		s.sendError(c, http.StatusInternalServerError, err)
		return
	}

	audioID := uuid.New().String()
	textMessage := map[string]any{
		"id": uuid.New().String(),
		"choices": []map[string]any{
			{
				"index": 0,
				"delta": map[string]any{
					"audio": map[string]any{
						"id":         audioID,
						"transcript": textContent,
					},
				},
				"finish_reason": nil,
			},
		},
	}

	data, _ := json.Marshal(textMessage)
	c.SSEvent("data", string(data))

	for _, chunk := range audioChunks {
		audioMessage := map[string]any{
			"id": uuid.New().String(),
			"choices": []map[string]any{
				{
					"index": 0,
					"delta": map[string]any{
						"audio": map[string]any{
							"id":   audioID,
							"data": base64.StdEncoding.EncodeToString(chunk),
						},
					},
					"finish_reason": nil,
				},
			},
		}
		data, _ := json.Marshal(audioMessage)
		c.SSEvent("data", string(data))
	}

	c.SSEvent("data", "[DONE]")
}

// handleChatCompletion handles the chat completion endpoint with tool execution.
func (s *Server) handleChatCompletion(c *gin.Context) {
	var request ChatCompletionRequest

	if err := c.ShouldBindJSON(&request); err != nil {
		s.sendError(c, http.StatusBadRequest, err)
		return
	}

	model := request.Model
	if model == "" {
		model = s.model
	}

	appID, userID, channel := extractContext(request)
	tools := getToolsForRequest(request.Tools)
	messages := s.buildMessagesWithHistory(appID, userID, channel, request.Messages)
	oaiMessages := messagesToOpenAI(messages)

	if !request.Stream {
		// ── Non-streaming with multi-pass tool execution ──
		var lastResponse openai.ChatCompletionResponse
		for pass := 0; pass < 5; pass++ {
			req := openai.ChatCompletionRequest{
				Model:    model,
				Messages: oaiMessages,
			}
			if len(tools) > 0 {
				req.Tools = tools
			}

			response, err := s.client.CreateChatCompletion(c.Request.Context(), req)
			if err != nil {
				s.sendError(c, http.StatusInternalServerError, err)
				return
			}
			lastResponse = response

			choice := response.Choices[0]

			if len(choice.Message.ToolCalls) == 0 {
				content := choice.Message.Content
				if content != "" {
					s.convStore.SaveMessage(appID, userID, channel, ConversationMessage{
						Role:    "assistant",
						Content: content,
					})
				}
				c.JSON(http.StatusOK, response)
				return
			}

			// Execute tools
			assistantMsg := openai.ChatCompletionMessage{
				Role:      "assistant",
				Content:   choice.Message.Content,
				ToolCalls: choice.Message.ToolCalls,
			}
			oaiMessages = append(oaiMessages, assistantMsg)

			s.convStore.SaveMessage(appID, userID, channel, ConversationMessage{
				Role:      "assistant",
				Content:   choice.Message.Content,
				ToolCalls: toolCallsToMapSlice(choice.Message.ToolCalls),
			})

			toolResults := executeTools(choice.Message.ToolCalls, appID, userID, channel)
			for _, tr := range toolResults {
				content, _ := tr.Content.(string)
				oaiMessages = append(oaiMessages, openai.ChatCompletionMessage{
					Role:       "tool",
					Content:    content,
					ToolCallID: tr.ToolCallID,
					Name:       tr.Name,
				})
				s.convStore.SaveMessage(appID, userID, channel, ConversationMessage{
					Role:       "tool",
					Content:    content,
					ToolCallID: tr.ToolCallID,
					Name:       tr.Name,
				})
			}
		}

		// Max passes reached — return the last LLM response instead of an error
		s.logger.Warn("Max tool execution passes reached, returning last response")
		c.JSON(http.StatusOK, lastResponse)
		return
	}

	// ── Streaming with tool execution ──
	c.Header("Content-Type", "text/event-stream")

	currentMessages := oaiMessages

	for pass := 0; pass < 5; pass++ {
		req := openai.ChatCompletionRequest{
			Model:    model,
			Messages: currentMessages,
			Stream:   true,
		}
		if len(tools) > 0 {
			req.Tools = tools
		}

		stream, err := s.client.CreateChatCompletionStream(c.Request.Context(), req)
		if err != nil {
			s.sendError(c, http.StatusInternalServerError, err)
			return
		}

		type accToolCall struct {
			ID       string
			Type     string
			FuncName string
			FuncArgs string
		}

		var accumulatedToolCalls []accToolCall
		accumulatedContent := ""
		finishReason := ""

		for {
			response, err := stream.Recv()
			if err == io.EOF {
				break
			}
			if err != nil {
				s.logger.Error("Stream error", "err", err)
				stream.Close()
				return
			}

			if len(response.Choices) == 0 {
				continue
			}

			choice := response.Choices[0]
			delta := choice.Delta

			if choice.FinishReason != "" {
				finishReason = string(choice.FinishReason)
			}

			// Accumulate tool calls
			if len(delta.ToolCalls) > 0 {
				for _, tc := range delta.ToolCalls {
					idx := tc.Index
					if idx == nil {
						zero := 0
						idx = &zero
					}
					for len(accumulatedToolCalls) <= *idx {
						accumulatedToolCalls = append(accumulatedToolCalls, accToolCall{})
					}
					entry := &accumulatedToolCalls[*idx]
					if tc.ID != "" {
						entry.ID = tc.ID
					}
					if tc.Type != "" {
						entry.Type = string(tc.Type)
					}
					if tc.Function.Name != "" {
						entry.FuncName = tc.Function.Name
					}
					entry.FuncArgs += tc.Function.Arguments
				}
				continue // Don't send tool call chunks to client
			}

			if delta.Content != "" {
				accumulatedContent += delta.Content
			}

			// Send non-tool chunks to client
			data, _ := json.Marshal(response)
			c.SSEvent("data", string(data))
		}

		stream.Close()

		if finishReason == "tool_calls" && len(accumulatedToolCalls) > 0 {
			// Convert accumulated tool calls to openai format
			var oaiToolCalls []openai.ToolCall
			for _, atc := range accumulatedToolCalls {
				oaiToolCalls = append(oaiToolCalls, openai.ToolCall{
					ID:   atc.ID,
					Type: openai.ToolTypeFunction,
					Function: openai.FunctionCall{
						Name:      atc.FuncName,
						Arguments: atc.FuncArgs,
					},
				})
			}

			// Save assistant message with tool calls
			assistantMsg := openai.ChatCompletionMessage{
				Role:      "assistant",
				Content:   accumulatedContent,
				ToolCalls: oaiToolCalls,
			}
			currentMessages = append(currentMessages, assistantMsg)

			s.convStore.SaveMessage(appID, userID, channel, ConversationMessage{
				Role:      "assistant",
				Content:   accumulatedContent,
				ToolCalls: toolCallsToMapSlice(oaiToolCalls),
			})

			// Execute tools
			toolResults := executeTools(oaiToolCalls, appID, userID, channel)
			for _, tr := range toolResults {
				content, _ := tr.Content.(string)
				currentMessages = append(currentMessages, openai.ChatCompletionMessage{
					Role:       "tool",
					Content:    content,
					ToolCallID: tr.ToolCallID,
					Name:       tr.Name,
				})
				s.convStore.SaveMessage(appID, userID, channel, ConversationMessage{
					Role:       "tool",
					Content:    content,
					ToolCallID: tr.ToolCallID,
					Name:       tr.Name,
				})
			}

			continue // Loop back for another LLM call
		}

		// No tool calls — save and end
		if accumulatedContent != "" {
			s.convStore.SaveMessage(appID, userID, channel, ConversationMessage{
				Role:    "assistant",
				Content: accumulatedContent,
			})
		}
		break
	}

	c.SSEvent("data", "[DONE]")
}

// handleRAGChatCompletion handles the RAG chat completion endpoint.
func (s *Server) handleRAGChatCompletion(c *gin.Context) {
	var request ChatCompletionRequest

	if err := c.ShouldBindJSON(&request); err != nil {
		s.sendError(c, http.StatusBadRequest, err)
		return
	}

	if !request.Stream {
		s.sendError(c, http.StatusBadRequest, fmt.Errorf("chat completions require streaming"))
		return
	}

	model := request.Model
	if model == "" {
		model = s.model
	}

	appID, userID, channel := extractContext(request)

	c.Header("Content-Type", "text/event-stream")

	// Send waiting message
	waitingMsg := map[string]any{
		"id": "waiting_msg",
		"choices": []map[string]any{
			{
				"index": 0,
				"delta": map[string]any{
					"role":    "assistant",
					"content": waitingMessages[rand.Intn(len(waitingMessages))],
				},
				"finish_reason": nil,
			},
		},
	}
	data, _ := json.Marshal(waitingMsg)
	c.SSEvent("data", string(data))

	// Build messages with history
	messages := s.buildMessagesWithHistory(appID, userID, channel, request.Messages)

	// Perform RAG retrieval
	retrievedContext := PerformRAGRetrieval(messages)

	// Adjust messages
	refactedMessages := RefactMessages(retrievedContext, messages)

	// Convert to OpenAI format
	oaiMessages := messagesToOpenAI(refactedMessages)

	req := openai.ChatCompletionRequest{
		Model:    model,
		Messages: oaiMessages,
		Stream:   true,
	}

	if len(request.Tools) > 0 {
		req.Tools = toolsToOpenAI(request.Tools)
	}

	stream, err := s.client.CreateChatCompletionStream(c.Request.Context(), req)
	if err != nil {
		s.sendError(c, http.StatusInternalServerError, err)
		return
	}
	defer stream.Close()

	accumulatedContent := ""

	for {
		response, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			s.sendError(c, http.StatusInternalServerError, err)
			return
		}

		if len(response.Choices) > 0 && response.Choices[0].Delta.Content != "" {
			accumulatedContent += response.Choices[0].Delta.Content
		}

		data, _ := json.Marshal(response)
		c.SSEvent("data", string(data))
	}

	// Save assistant response
	if accumulatedContent != "" {
		s.convStore.SaveMessage(appID, userID, channel, ConversationMessage{
			Role:    "assistant",
			Content: accumulatedContent,
		})
	}

	c.SSEvent("data", "[DONE]")
}

func (s *Server) readPCMFile(filePath string, sampleRate int, durationMs int) ([][]byte, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read PCM file: %w", err)
	}

	chunkSize := int(float64(sampleRate) * 2 * float64(durationMs) / 1000.0)
	if chunkSize == 0 {
		return nil, fmt.Errorf("invalid chunk size: sample rate %d, duration %dms", sampleRate, durationMs)
	}

	chunks := make([][]byte, 0, len(data)/chunkSize+1)
	for i := 0; i < len(data); i += chunkSize {
		end := i + chunkSize
		if end > len(data) {
			end = len(data)
		}
		chunks = append(chunks, data[i:end])
	}

	return chunks, nil
}

func (s *Server) readTextFile(filePath string) (string, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return "", fmt.Errorf("failed to read text file: %w", err)
	}
	return string(data), nil
}

func (s *Server) sendError(c *gin.Context, status int, err error) {
	c.JSON(status, gin.H{"detail": err.Error()})
}

func (s *Server) setupRoutes(r *gin.Engine) {
	r.GET("/ping", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	r.POST("/audio/chat/completions", s.handleAudioChatCompletion)
	r.POST("/chat/completions", s.handleChatCompletion)
	r.POST("/rag/chat/completions", s.handleRAGChatCompletion)
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getLLMAPIKey() string {
	for _, key := range []string{"LLM_API_KEY", "YOUR_LLM_API_KEY", "OPENAI_API_KEY"} {
		if v := os.Getenv(key); v != "" {
			return v
		}
	}
	return ""
}

func main() {
	apiKey := getLLMAPIKey()
	baseURL := getEnv("LLM_BASE_URL", "https://api.openai.com/v1")
	model := getEnv("LLM_MODEL", "gpt-4o-mini")

	_ = strings.TrimSpace(apiKey) // ensure import used

	server := NewServer(apiKey, baseURL, model)
	r := gin.Default()
	server.setupRoutes(r)
	r.Run(":8102")
}
