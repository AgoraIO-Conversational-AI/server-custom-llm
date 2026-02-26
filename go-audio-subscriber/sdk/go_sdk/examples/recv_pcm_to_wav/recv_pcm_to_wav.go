package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"os/signal"
	"time"

	agoraservice "github.com/AgoraIO-Extensions/Agora-Golang-Server-SDK/v2/go_sdk/rtc"
)

type WavWriter struct {
	file          *os.File
	dataSize      uint32
	sampleRate    uint32
	numChannels   uint16
	bitsPerSample uint16
}

func NewWavWriter(filename string, sampleRate uint32, numChannels uint16, bitsPerSample uint16) (*WavWriter, error) {
	file, err := os.Create(filename)
	if err != nil {
		return nil, err
	}

	w := &WavWriter{
		file:          file,
		dataSize:      0,
		sampleRate:    sampleRate,
		numChannels:   numChannels,
		bitsPerSample: bitsPerSample,
	}

	// Write placeholder header (will be updated when closing)
	w.writeHeader()

	return w, nil
}

func (w *WavWriter) writeHeader() error {
	// RIFF header
	w.file.Write([]byte("RIFF"))
	binary.Write(w.file, binary.LittleEndian, uint32(36+w.dataSize)) // File size - 8
	w.file.Write([]byte("WAVE"))

	// fmt chunk
	w.file.Write([]byte("fmt "))
	binary.Write(w.file, binary.LittleEndian, uint32(16))                                  // fmt chunk size
	binary.Write(w.file, binary.LittleEndian, uint16(1))                                   // Audio format (1 = PCM)
	binary.Write(w.file, binary.LittleEndian, w.numChannels)                               // Number of channels
	binary.Write(w.file, binary.LittleEndian, w.sampleRate)                                // Sample rate
	binary.Write(w.file, binary.LittleEndian, w.sampleRate*uint32(w.numChannels*w.bitsPerSample/8)) // Byte rate
	binary.Write(w.file, binary.LittleEndian, w.numChannels*w.bitsPerSample/8)            // Block align
	binary.Write(w.file, binary.LittleEndian, w.bitsPerSample)                             // Bits per sample

	// data chunk
	w.file.Write([]byte("data"))
	binary.Write(w.file, binary.LittleEndian, w.dataSize) // Data size

	return nil
}

func (w *WavWriter) WriteData(data []byte) error {
	n, err := w.file.Write(data)
	if err != nil {
		return err
	}
	w.dataSize += uint32(n)
	return nil
}

func (w *WavWriter) Close() error {
	// Update header with final data size
	w.file.Seek(0, 0)
	w.writeHeader()
	return w.file.Close()
}

func main() {
	bStop := new(bool)
	*bStop = false

	// catch terminal signal
	go func() {
		c := make(chan os.Signal, 1)
		signal.Notify(c, os.Interrupt)
		<-c
		*bStop = true
		fmt.Println("\nStopping recording...")
	}()

	println("Receive PCM and save to WAV\nusage:\n\t./recv_pcm_to_wav <appid> <channel_name> [output.wav]\n\tpress ctrl+c to stop recording\n")

	argus := os.Args
	if len(argus) < 3 {
		fmt.Println("Please input appid, channel name")
		return
	}
	appid := argus[1]
	channelName := argus[2]
	outputFile := "output.wav"
	if len(argus) >= 4 {
		outputFile = argus[3]
	}

	userId := "0"
	token := ""

	// Initialize WAV writer (16kHz, 1 channel, 16-bit)
	wavWriter, err := NewWavWriter(outputFile, 16000, 1, 16)
	if err != nil {
		fmt.Println("Failed to create WAV file:", err)
		return
	}
	defer wavWriter.Close()

	fmt.Printf("Recording to: %s\n", outputFile)

	svcCfg := agoraservice.NewAgoraServiceConfig()
	svcCfg.AppId = appid

	agoraservice.Initialize(svcCfg)
	defer agoraservice.Release()

	var conn *agoraservice.RtcConnection = nil

	conCfg := agoraservice.RtcConnectionConfig{
		AutoSubscribeAudio: true,
		AutoSubscribeVideo: false,
		ClientRole:         agoraservice.ClientRoleBroadcaster,
		ChannelProfile:     agoraservice.ChannelProfileLiveBroadcasting,
	}

	publishConfig := agoraservice.NewRtcConPublishConfig()
	publishConfig.IsPublishAudio = false
	publishConfig.IsPublishVideo = false

	conSignal := make(chan struct{})
	OnDisconnectedSign := make(chan struct{})

	conHandler := &agoraservice.RtcConnectionObserver{
		OnConnected: func(con *agoraservice.RtcConnection, info *agoraservice.RtcConnectionInfo, reason int) {
			fmt.Printf("Connected to channel: %s\n", channelName)
			conSignal <- struct{}{}
		},
		OnDisconnected: func(con *agoraservice.RtcConnection, info *agoraservice.RtcConnectionInfo, reason int) {
			fmt.Printf("Disconnected\n")
			OnDisconnectedSign <- struct{}{}
		},
		OnUserJoined: func(con *agoraservice.RtcConnection, uid string) {
			fmt.Println("User joined:", uid)
		},
		OnUserLeft: func(con *agoraservice.RtcConnection, uid string, reason int) {
			fmt.Printf("User left: %s\n", uid)
		},
	}

	frameCount := 0
	audioObserver := &agoraservice.AudioFrameObserver{
		OnPlaybackAudioFrameBeforeMixing: func(localUser *agoraservice.LocalUser, channelId string, userId string, frame *agoraservice.AudioFrame, vadResultState agoraservice.VadState, vadResultFrame *agoraservice.AudioFrame) bool {
			// Write PCM data to WAV file
			err := wavWriter.WriteData(frame.Buffer)
			if err != nil {
				fmt.Printf("Error writing audio data: %v\n", err)
			}
			frameCount++
			if frameCount%100 == 0 {
				fmt.Printf("Recorded %d frames (%.1f seconds)\n", frameCount, float64(frameCount*10)/1000.0)
			}
			return true
		},
	}

	conn = agoraservice.NewRtcConnection(&conCfg, publishConfig)
	conn.RegisterObserver(conHandler)

	localUser := conn.GetLocalUser()
	conn.Connect(token, channelName, userId)
	<-conSignal

	localUser = conn.GetLocalUser()
	localUser.SetPlaybackAudioFrameBeforeMixingParameters(1, 16000)

	conn.RegisterAudioFrameObserver(audioObserver, 0, nil)

	// Wait for stop signal
	for !(*bStop) {
		time.Sleep(100 * time.Millisecond)
	}

	fmt.Printf("\nRecording stopped. Saved %d frames to %s\n", frameCount, outputFile)

	conn.Disconnect()
	<-OnDisconnectedSign

	conn.Release()
	agoraservice.Release()

	fmt.Printf("WAV file saved: %s\n", outputFile)
	fmt.Printf("Duration: %.2f seconds\n", float64(frameCount*10)/1000.0)
}
