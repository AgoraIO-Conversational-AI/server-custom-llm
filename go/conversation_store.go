package main

import (
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"
)

const (
	maxMessages     = 100
	targetMessages  = 75
	cleanupInterval = 1 * time.Hour
	maxAge          = 24 * time.Hour
)

// ConversationMessage represents a stored message with metadata.
type ConversationMessage struct {
	Role       string         `json:"role"`
	Content    string         `json:"content"`
	Name       string         `json:"name,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
	ToolCalls  []map[string]any `json:"tool_calls,omitempty"`
	Timestamp  float64        `json:"timestamp"`
}

// Conversation holds the messages and metadata for a single conversation.
type Conversation struct {
	Messages    []ConversationMessage
	LastUpdated time.Time
}

// ConversationStore is a thread-safe in-memory conversation store.
type ConversationStore struct {
	mu            sync.RWMutex
	conversations map[string]*Conversation
}

// NewConversationStore creates a new conversation store and starts the cleanup goroutine.
func NewConversationStore() *ConversationStore {
	cs := &ConversationStore{
		conversations: make(map[string]*Conversation),
	}
	go cs.cleanupLoop()
	slog.Info("Conversation store initialized",
		"maxMessages", maxMessages,
		"targetMessages", targetMessages,
		"cleanupInterval", cleanupInterval.String(),
	)
	return cs
}

func conversationKey(appID, userID, channel string) string {
	return fmt.Sprintf("%s:%s:%s", appID, userID, channel)
}

// GetOrCreateConversation returns an existing conversation or creates a new one.
func (cs *ConversationStore) GetOrCreateConversation(appID, userID, channel string) *Conversation {
	key := conversationKey(appID, userID, channel)
	cs.mu.Lock()
	defer cs.mu.Unlock()

	if conv, ok := cs.conversations[key]; ok {
		return conv
	}

	slog.Info("Creating new conversation", "key", key)
	conv := &Conversation{
		Messages:    []ConversationMessage{},
		LastUpdated: time.Now(),
	}
	cs.conversations[key] = conv
	return conv
}

// SaveMessage appends a message to a conversation and trims if needed.
func (cs *ConversationStore) SaveMessage(appID, userID, channel string, msg ConversationMessage) {
	key := conversationKey(appID, userID, channel)
	cs.mu.Lock()
	defer cs.mu.Unlock()

	conv, ok := cs.conversations[key]
	if !ok {
		conv = &Conversation{
			Messages:    []ConversationMessage{},
			LastUpdated: time.Now(),
		}
		cs.conversations[key] = conv
	}

	msg.Timestamp = float64(time.Now().UnixMilli()) / 1000.0
	conv.Messages = append(conv.Messages, msg)
	conv.LastUpdated = time.Now()

	if len(conv.Messages) > maxMessages {
		cs.trimConversation(conv)
	}

	slog.Debug("Saved message",
		"role", msg.Role,
		"total", len(conv.Messages),
		"key", key,
	)
}

// GetMessages returns a copy of the conversation messages.
func (cs *ConversationStore) GetMessages(appID, userID, channel string) []ConversationMessage {
	key := conversationKey(appID, userID, channel)
	cs.mu.RLock()
	defer cs.mu.RUnlock()

	conv, ok := cs.conversations[key]
	if !ok {
		return []ConversationMessage{}
	}

	result := make([]ConversationMessage, len(conv.Messages))
	copy(result, conv.Messages)
	return result
}

func (cs *ConversationStore) trimConversation(conv *Conversation) {
	messages := conv.Messages

	var systemMsgs []ConversationMessage
	var nonSystem []ConversationMessage

	for _, m := range messages {
		if m.Role == "system" {
			systemMsgs = append(systemMsgs, m)
		} else {
			nonSystem = append(nonSystem, m)
		}
	}

	// Keep the most recent targetMessages non-system messages
	start := 0
	if len(nonSystem) > targetMessages {
		start = len(nonSystem) - targetMessages
	}
	kept := nonSystem[start:]

	// Collect tool_call IDs in kept
	toolCallIDs := make(map[string]bool)
	for _, m := range kept {
		if m.Role == "tool" && m.ToolCallID != "" {
			toolCallIDs[m.ToolCallID] = true
		}
		if m.Role == "assistant" && len(m.ToolCalls) > 0 {
			for _, tc := range m.ToolCalls {
				if id, ok := tc["id"].(string); ok {
					toolCallIDs[id] = true
				}
			}
		}
	}

	// Add orphaned pair messages
	for _, m := range nonSystem[:start] {
		if m.Role == "assistant" && len(m.ToolCalls) > 0 {
			for _, tc := range m.ToolCalls {
				if id, ok := tc["id"].(string); ok && toolCallIDs[id] {
					kept = append([]ConversationMessage{m}, kept...)
					break
				}
			}
		} else if m.Role == "tool" && toolCallIDs[m.ToolCallID] {
			kept = append([]ConversationMessage{m}, kept...)
		}
	}

	sort.Slice(kept, func(i, j int) bool {
		return kept[i].Timestamp < kept[j].Timestamp
	})

	oldLen := len(conv.Messages)
	conv.Messages = append(systemMsgs, kept...)
	slog.Debug("Trimmed conversation",
		"from", oldLen,
		"to", len(conv.Messages),
	)
}

func (cs *ConversationStore) cleanupLoop() {
	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()

	for range ticker.C {
		cs.cleanupOldConversations()
	}
}

func (cs *ConversationStore) cleanupOldConversations() {
	cs.mu.Lock()
	defer cs.mu.Unlock()

	now := time.Now()
	removed := 0
	for key, conv := range cs.conversations {
		if now.Sub(conv.LastUpdated) > maxAge {
			delete(cs.conversations, key)
			removed++
		}
	}
	if removed > 0 {
		slog.Info("Cleaned up old conversations", "removed", removed)
	}
}
