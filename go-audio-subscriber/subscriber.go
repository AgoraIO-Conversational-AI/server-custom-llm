package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"time"

	agoraservice "github.com/AgoraIO-Extensions/Agora-Golang-Server-SDK/v2/go_sdk/rtc"
)

// Subscriber manages the Agora SDK connection and audio subscription
type Subscriber struct {
	appID     string
	channel   string
	botUID    string
	token     string
	targetUID string

	conn        *agoraservice.RtcConnection
	isConnected bool
	stopChan    chan struct{}
	writer      *FrameWriter
}

// NewSubscriber creates a new audio subscriber
func NewSubscriber(writer *FrameWriter) *Subscriber {
	return &Subscriber{
		stopChan: make(chan struct{}),
		writer:   writer,
	}
}

// Start connects to the Agora channel and subscribes to the target UID's audio
func (s *Subscriber) Start(appID, channel, botUID, token, targetUID string) error {
	s.appID = appID
	s.channel = channel
	s.botUID = botUID
	s.token = token
	s.targetUID = targetUID

	logger.Printf("Starting subscriber: channel=%s botUID=%s targetUID=%s", channel, botUID, targetUID)

	// Initialize Agora service
	svcCfg := agoraservice.NewAgoraServiceConfig()
	svcCfg.AppId = appID
	svcCfg.LogPath = "/tmp/agora_audio_sub/agorasdk.log"
	svcCfg.ConfigDir = "/tmp/agora_audio_sub"
	svcCfg.DataDir = "/tmp/agora_audio_sub"

	// Ensure log directory exists
	os.MkdirAll("/tmp/agora_audio_sub", 0755)

	agoraservice.Initialize(svcCfg)
	logger.Println("Agora service initialized")

	// Create RTC connection config - manual subscription only
	conCfg := &agoraservice.RtcConnectionConfig{
		AutoSubscribeAudio: false,
		AutoSubscribeVideo: false,
		ClientRole:         agoraservice.ClientRoleAudience,
		ChannelProfile:     agoraservice.ChannelProfileLiveBroadcasting,
	}

	// Not publishing, only subscribing
	publishConfig := agoraservice.NewRtcConPublishConfig()
	publishConfig.AudioPublishType = agoraservice.AudioPublishTypePcm
	publishConfig.IsPublishAudio = false
	publishConfig.IsPublishVideo = false
	publishConfig.AudioScenario = agoraservice.AudioScenarioDefault

	s.conn = agoraservice.NewRtcConnection(conCfg, publishConfig)
	if s.conn == nil {
		return fmt.Errorf("failed to create RTC connection")
	}

	// Wait for connection
	connSignal := make(chan struct{}, 1)
	targetLeftChan := make(chan struct{})

	// Register connection observer
	connObserver := &agoraservice.RtcConnectionObserver{
		OnConnected: func(con *agoraservice.RtcConnection, info *agoraservice.RtcConnectionInfo, reason int) {
			logger.Printf("Connected to channel: %s as UID %s", info.ChannelId, s.botUID)
			s.writer.WriteJSON(&StatusMessage{
				Type:    "status",
				Status:  "connected",
				Message: fmt.Sprintf("Connected to channel %s", info.ChannelId),
			})
			select {
			case connSignal <- struct{}{}:
			default:
			}
		},
		OnDisconnected: func(con *agoraservice.RtcConnection, info *agoraservice.RtcConnectionInfo, reason int) {
			logger.Printf("Disconnected from channel: %s (reason: %d)", info.ChannelId, reason)
			s.writer.WriteJSON(&StatusMessage{
				Type:    "status",
				Status:  "disconnected",
				Message: fmt.Sprintf("Disconnected (reason: %d)", reason),
			})
		},
		OnUserJoined: func(con *agoraservice.RtcConnection, uid string) {
			logger.Printf("User joined: UID %s (target=%s)", uid, s.targetUID)

			if uid == s.targetUID {
				localUser := con.GetLocalUser()
				if localUser == nil {
					logger.Println("ERROR: localUser is nil, cannot subscribe")
					return
				}
				ret := localUser.SubscribeAudio(uid)
				if ret == 0 {
					logger.Printf("Subscribed to audio from UID %s", uid)
					s.writer.WriteJSON(&StatusMessage{
						Type:    "status",
						Status:  "subscribed",
						Message: fmt.Sprintf("Subscribed to UID %s", uid),
						UID:     uid,
					})
				} else {
					logger.Printf("ERROR: Failed to subscribe to UID %s, ret=%d", uid, ret)
				}
			}
		},
		OnUserLeft: func(con *agoraservice.RtcConnection, uid string, reason int) {
			logger.Printf("User left: UID %s (reason: %d)", uid, reason)

			if uid == s.targetUID {
				logger.Printf("Target UID %s left channel", uid)
				s.writer.WriteJSON(&StatusMessage{
					Type:    "status",
					Status:  "target_left",
					Message: fmt.Sprintf("Target UID %s left", uid),
					UID:     uid,
				})
				select {
				case <-targetLeftChan:
				default:
					close(targetLeftChan)
				}
			}
		},
	}

	s.conn.RegisterObserver(connObserver)

	localUserObserver := &agoraservice.LocalUserObserver{
		OnStreamMessage: func(localUser *agoraservice.LocalUser, uid string, streamId int, data []byte) {
			if len(data) == 0 {
				return
			}
			if err := s.writer.WriteObject(&StreamMessage{
				Type:     "stream_message",
				UID:      uid,
				StreamID: streamId,
				Data:     base64.StdEncoding.EncodeToString(data),
			}); err != nil {
				logger.Printf("Error writing stream message: %v", err)
			}
		},
	}
	s.conn.RegisterLocalUserObserver(localUserObserver)
	logger.Println("Local user observer registered")

	// Connect
	s.conn.Connect(token, channel, botUID)
	logger.Printf("Connecting to channel %s as UID %s...", channel, botUID)

	// Wait for connection with timeout
	select {
	case <-connSignal:
		logger.Println("Connection established")
	case <-time.After(15 * time.Second):
		s.conn.Disconnect()
		s.conn.Release()
		agoraservice.Release()
		return fmt.Errorf("connection timeout after 15 seconds")
	}

	// Set audio parameters: mono, 16kHz
	localUser := s.conn.GetLocalUser()
	if localUser != nil {
		localUser.SetPlaybackAudioFrameBeforeMixingParameters(1, 16000)
		logger.Println("Audio parameters set: mono 16kHz")
	}

	// Register audio frame observer - pipe raw PCM to stdout
	audioObserver := &agoraservice.AudioFrameObserver{
		OnPlaybackAudioFrameBeforeMixing: func(localUser *agoraservice.LocalUser, channelId string, userId string, frame *agoraservice.AudioFrame, vadResultState agoraservice.VadState, vadResultFrame *agoraservice.AudioFrame) bool {
			if userId != s.targetUID {
				return true
			}

			// Write raw PCM directly to stdout via framing protocol
			if len(frame.Buffer) > 0 {
				if err := s.writer.WritePCM(frame.Buffer); err != nil {
					logger.Printf("Error writing PCM frame: %v", err)
				}
			}
			return true
		},
	}

	s.conn.RegisterAudioFrameObserver(audioObserver, 0, nil)
	logger.Println("Audio frame observer registered")

	s.isConnected = true
	s.writer.WriteJSON(&StatusMessage{
		Type:    "status",
		Status:  "ready",
		Message: fmt.Sprintf("Subscribed to UID %s in channel %s", targetUID, channel),
	})

	// Wait for stop signal or target leaving
	select {
	case <-s.stopChan:
		logger.Println("Stop signal received")
	case <-targetLeftChan:
		logger.Println("Target user left, shutting down")
	}

	return nil
}

// Stop disconnects and releases resources
func (s *Subscriber) Stop() {
	if !s.isConnected {
		return
	}

	select {
	case <-s.stopChan:
	default:
		close(s.stopChan)
	}

	if s.conn != nil {
		s.conn.Disconnect()
		s.conn.Release()
		logger.Println("Disconnected from channel")
	}

	agoraservice.Release()
	logger.Println("Agora service released")
	s.isConnected = false
}
