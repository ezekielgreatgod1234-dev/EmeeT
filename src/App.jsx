
import { useState, useRef, useEffect } from 'react'
import Peer from 'peerjs'
import { createWorker } from 'tesseract.js'

function App() {
  const [roomCode, setRoomCode] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [showJoinModal, setShowJoinModal] = useState(false)

  const [isHost, setIsHost] = useState(true)
  const [isSharing, setIsSharing] = useState(false)
  const [remoteStream, setRemoteStream] = useState(null)
  const [joiners, setJoiners] = useState([])

  const [status, setStatus] = useState('idle')
  const [isScanning, setIsScanning] = useState(false)
  const [ocrProgress, setOcrProgress] = useState(0)
  const [ocrError, setOcrError] = useState('')

  const [extractedQuestion, setExtractedQuestion] = useState(null)
  const [showClaudeConfirmation, setShowClaudeConfirmation] = useState(false)
  const [copied, setCopied] = useState(false)
  const [autoDetect, setAutoDetect] = useState(true)
  const [isSelectingCrop, setIsSelectingCrop] = useState(false)
  const [cropRect, setCropRect] = useState(null)
  const [cropDraft, setCropDraft] = useState(null)
  const [lastScanTime, setLastScanTime] = useState('')

  const videoRef = useRef(null)
  const remoteVideoRef = useRef(null)

  const peerRef = useRef(null)
  const localStreamRef = useRef(null)
  const connectionsRef = useRef([])
  const callsRef = useRef([])
  const isScanningRef = useRef(false)
  const scanScreenRef = useRef(null)
  const cropStartRef = useRef(null)

  // Attach local screen preview.
  useEffect(() => {
    if (videoRef.current && localStreamRef.current) {
      videoRef.current.srcObject = localStreamRef.current
      videoRef.current.play().catch(console.error)
    }
  }, [isSharing])

  // Attach remote screen preview.
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream
      remoteVideoRef.current.play().catch(console.error)
    }
  }, [remoteStream])

  // Keep the latest scanner available to the automatic scan timer.
  useEffect(() => {
    scanScreenRef.current = scanScreen
  })

  // Automatically check the live screen periodically without overlapping scans.
  useEffect(() => {
    const hasLiveScreen = isHost ? isSharing : Boolean(remoteStream)
    if (!autoDetect || !hasLiveScreen) return

    const timer = window.setInterval(() => {
      if (!isScanningRef.current && scanScreenRef.current) {
        scanScreenRef.current({ automatic: true })
      }
    }, 8000)

    return () => window.clearInterval(timer)
  }, [autoDetect, isHost, isSharing, remoteStream])

  // Cleanup when app closes.
  useEffect(() => {
    return () => {
      localStreamRef.current?.getTracks().forEach(track => track.stop())
      callsRef.current.forEach(call => call.close())
      connectionsRef.current.forEach(conn => conn.close())
      peerRef.current?.destroy()
    }
  }, [])

  const createPeer = id => {
    return new Peer(id, { debug: 1 })
  }

  // CREATE SESSION
  const handleStartCall = () => {
    if (peerRef.current) return

    const code = Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase()

    setRoomCode(code)
    setIsHost(true)
    setStatus('creating')

    const peer = createPeer(code)
    peerRef.current = peer

    peer.on('open', () => {
      setStatus('waiting')
    })

    peer.on('connection', conn => {
      conn.on('open', () => {
        connectionsRef.current.push(conn)

        setJoiners(prev => {
          if (prev.includes(conn.peer)) return prev
          return [...prev, conn.peer]
        })

        setStatus('live')

        // If the host is already sharing, send the stream.
        if (localStreamRef.current) {
          const call = peer.call(conn.peer, localStreamRef.current)

          if (call) {
            callsRef.current.push(call)
          }
        }
      })

      conn.on('close', () => {
        connectionsRef.current =
          connectionsRef.current.filter(item => item !== conn)

        setJoiners(prev =>
          prev.filter(id => id !== conn.peer)
        )
      })
    })

    peer.on('error', error => {
      console.error('Peer error:', error)
      setStatus('idle')
      alert(`Connection error: ${error.type}`)
    })
  }

  // JOIN SESSION
  const handleJoin = () => {
    const code = joinCode.trim().toUpperCase()

    if (!code) return

    setRoomCode(code)
    setIsHost(false)
    setStatus('creating')
    setShowJoinModal(false)

    const peer = createPeer()
    peerRef.current = peer

    peer.on('open', () => {
      const conn = peer.connect(code)
      connectionsRef.current.push(conn)

      conn.on('open', () => {
        setStatus('live')
        setJoiners([code])
      })

      conn.on('error', error => {
        console.error(error)
        alert('Unable to connect. Check the room code.')
        setStatus('idle')
      })
    })

    // Receive the laptop screen.
    peer.on('call', call => {
      call.answer()
      callsRef.current.push(call)

      call.on('stream', stream => {
        setRemoteStream(stream)
        setStatus('live')
      })

      call.on('close', () => {
        setRemoteStream(null)
      })

      call.on('error', error => {
        console.error('Stream error:', error)
      })
    })

    peer.on('error', error => {
      console.error(error)

      if (error.type === 'peer-unavailable') {
        alert('Host not found. Check that the laptop session is active.')
        setStatus('idle')
      }
    })
  }

  // START SCREEN SHARING
  const startScreenShare = async () => {
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        alert('Screen sharing requires a supported browser and secure connection.')
        return
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 15, max: 30 }
        },
        audio: false
      })

      localStreamRef.current = stream

      setIsSharing(true)
      setStatus('live')
      setExtractedQuestion(null)
      setOcrError('')

      // Send screen to connected phones.
      if (peerRef.current) {
        connectionsRef.current.forEach(conn => {
          if (conn.open) {
            const call = peerRef.current.call(
              conn.peer,
              stream
            )

            if (call) {
              callsRef.current.push(call)
            }
          }
        })
      }

      stream.getVideoTracks()[0].addEventListener(
        'ended',
        stopScreenShare,
        { once: true }
      )

    } catch (error) {
      console.error('Screen sharing error:', error)

      if (error.name !== 'NotAllowedError') {
        alert('Unable to start screen sharing.')
      }
    }
  }

  // STOP SCREEN SHARING
  const stopScreenShare = () => {
    localStreamRef.current?.getTracks().forEach(track => {
      track.stop()
    })

    localStreamRef.current = null

    callsRef.current.forEach(call => call.close())
    callsRef.current = []

    setIsSharing(false)
    setExtractedQuestion(null)
    setOcrError('')

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }

    setStatus(roomCode ? 'waiting' : 'idle')
  }

  // CAPTURE SCREEN
  const captureScreenFrame = () => {
    const video = isHost
      ? videoRef.current
      : remoteVideoRef.current

    if (!video || !video.srcObject) {
      throw new Error('No shared screen is available.')
    }

    if (!video.videoWidth || !video.videoHeight) {
      throw new Error('Screen preview is not ready. Try again.')
    }

    const canvas = document.createElement('canvas')

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

    const context = canvas.getContext('2d', {
      willReadFrequently: true
    })

    context.drawImage(
      video,
      0,
      0,
      canvas.width,
      canvas.height
    )

    // If the user selected a region, crop OCR to that region only.
    if (cropRect) {
      const sx = Math.max(0, Math.round(canvas.width * cropRect.x / 100))
      const sy = Math.max(0, Math.round(canvas.height * cropRect.y / 100))
      const sw = Math.max(1, Math.round(canvas.width * cropRect.width / 100))
      const sh = Math.max(1, Math.round(canvas.height * cropRect.height / 100))
      const cropped = document.createElement('canvas')
      cropped.width = Math.min(sw, canvas.width - sx)
      cropped.height = Math.min(sh, canvas.height - sy)
      cropped.getContext('2d', { willReadFrequently: true }).drawImage(
        canvas, sx, sy, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height
      )
      return cropped
    }

    return canvas
  }

  // IMAGE ENHANCEMENT
  const preprocessImage = (sourceCanvas, scale = 2) => {
    const canvas = document.createElement('canvas')

    canvas.width = sourceCanvas.width * scale
    canvas.height = sourceCanvas.height * scale

    const context = canvas.getContext('2d', {
      willReadFrequently: true
    })

    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'

    context.drawImage(
      sourceCanvas,
      0,
      0,
      canvas.width,
      canvas.height
    )

    const imageData = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height
    )

    const pixels = imageData.data

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i]
      const g = pixels[i + 1]
      const b = pixels[i + 2]

      let gray =
        0.299 * r +
        0.587 * g +
        0.114 * b

      gray = (gray - 128) * 1.6 + 128

      gray = Math.max(0, Math.min(255, gray))

      pixels[i] = gray
      pixels[i + 1] = gray
      pixels[i + 2] = gray
    }

    context.putImageData(imageData, 0, 0)

    return canvas
  }

  // QUESTION AND OPTION EXTRACTION
  const extractQuestionAndOptions = text => {
    const lines = text
      .split('\n')
      .map(line =>
        line.replace(/\s+/g, ' ').trim()
      )
      .filter(line => line.length > 1)

    const optionRegex =
      /^(?:\(?\s*[a-d]\s*[\).:]|\(?\s*[1-4]\s*[\).:])\s*/i

    const questionKeywords =
      /\?|^(what|which|who|where|when|why|how|find|calculate|determine|identify|select|choose|state|explain|define|give|write|complete|solve|evaluate|convert|list|name|describe|compute)\b/i

    const metadataRegex =
      /^(task|home|day|time|level|course|subject|question|candidate|duration|marks|score|previous|next|pause|submit|show hint)\b/i

    const optionStart = lines.findIndex(line =>
      optionRegex.test(line)
    )

    let question = ''
    let options = []

    if (optionStart !== -1) {
      const beforeOptions = lines.slice(0, optionStart)

      const candidates = beforeOptions.filter(line =>
        line.length > 5 &&
        !metadataRegex.test(line)
      )

      const likelyQuestions = candidates.filter(line =>
        questionKeywords.test(line)
      )

      question = likelyQuestions.length
        ? likelyQuestions[likelyQuestions.length - 1]
        : candidates[candidates.length - 1] || ''

      options = lines
        .slice(optionStart)
        .filter(line => optionRegex.test(line))
        .slice(0, 8)
        .map(line => line.trim())

    } else {
      const candidates = lines.filter(line =>
        line.length > 10 &&
        !metadataRegex.test(line) &&
        questionKeywords.test(line)
      )

      question = candidates[candidates.length - 1] || ''
    }

    return {
      question: question.trim(),
      options
    }
  }

  // OCR SCANNING
  const scanScreen = async ({ automatic = false } = {}) => {
    if (isScanningRef.current) return
    if (!automatic) {
      setOcrError('')
      setExtractedQuestion(null)
    }

    let worker

    try {
      isScanningRef.current = true
      setIsScanning(true)
      setOcrProgress(0)

      const originalCanvas = captureScreenFrame()

      const enhancedCanvas = preprocessImage(
        originalCanvas,
        2
      )

      worker = await createWorker('eng', 1, {
        logger: message => {
          if (message.status === 'recognizing text') {
            setOcrProgress(
              Math.round(message.progress * 100)
            )
          }
        }
      })

      const results = []

      // PASS 1: Text block recognition.
      await worker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1'
      })

      const firstResult = await worker.recognize(
        enhancedCanvas
      )

      results.push(
        extractQuestionAndOptions(firstResult.data.text)
      )

      // PASS 2: Scattered text recognition.
      await worker.setParameters({
        tessedit_pageseg_mode: '11',
        preserve_interword_spaces: '1'
      })

      const secondResult = await worker.recognize(
        enhancedCanvas
      )

      results.push(
        extractQuestionAndOptions(secondResult.data.text)
      )

      // PASS 3: Automatic page recognition.
      await worker.setParameters({
        tessedit_pageseg_mode: '3',
        preserve_interword_spaces: '1'
      })

      const thirdResult = await worker.recognize(
        enhancedCanvas
      )

      results.push(
        extractQuestionAndOptions(thirdResult.data.text)
      )

      // Score each extraction.
      const score = result => {
        let points = 0

        if (result.question) {
          points += Math.min(result.question.length, 150)
        }

        points += result.options.length * 35

        return points
      }

      const bestExtraction = results.reduce(
        (best, current) =>
          score(current) > score(best) ? current : best,
        results[0]
      )

      if (!bestExtraction?.question) {
        if (!automatic) {
          setOcrError(
            'No clear question was found. Try selecting the question area and scanning again.'
          )
        }
        return
      }

      setExtractedQuestion(bestExtraction)
      setOcrError('')
      setLastScanTime(new Date().toLocaleTimeString())

    } catch (error) {
      console.error('OCR error:', error)

      if (!automatic) {
        setOcrError(error.message || 'Unable to scan the screen.')
      }

    } finally {
      if (worker) {
        await worker.terminate()
      }

      isScanningRef.current = false
      setIsScanning(false)
    }
  }

  // Select a screen region for more accurate OCR. Coordinates are stored as percentages.
  const startCropSelection = event => {
    if (!isSelectingCrop) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const point = {
      x: Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100)),
      y: Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100))
    }
    cropStartRef.current = point
    setCropDraft({ ...point, width: 0, height: 0 })
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const moveCropSelection = event => {
    if (!isSelectingCrop || !cropStartRef.current) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100))
    const y = Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100))
    const start = cropStartRef.current
    setCropDraft({ x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) })
  }

  const finishCropSelection = () => {
    if (cropDraft && cropDraft.width > 1 && cropDraft.height > 1) setCropRect(cropDraft)
    setCropDraft(null)
    cropStartRef.current = null
    setIsSelectingCrop(false)
  }

  // PREPARE CLAUDE MESSAGE
  const createClaudePrompt = () => {
    if (!extractedQuestion?.question) return ''

    const optionsText = extractedQuestion.options.length
      ? `\n\nOptions:\n${extractedQuestion.options.join('\n')}`
      : ''

    return `Give me the correct answer to this question and identify the correct option.

Question:
${extractedQuestion.question}${optionsText}`
  }

  // COPY MESSAGE AND OPEN CLAUDE
  const sendToClaude = async () => {
    if (!extractedQuestion?.question) return

    const prompt = createClaudePrompt()

    // Open synchronously from the button click to avoid popup blocking.
    const claudeWindow = window.open(
      'https://claude.ai/new',
      '_blank'
    )

    try {
      await navigator.clipboard.writeText(prompt)

      setCopied(true)
      setShowClaudeConfirmation(false)

      if (!claudeWindow) {
        alert('Message copied! Open Claude and paste with Ctrl + V.')
      }

    } catch (error) {
      console.error('Clipboard error:', error)

      claudeWindow?.close()

      alert(
        'Clipboard access failed. Please allow clipboard permission and try again.'
      )
    }
  }

  // COPY ROOM CODE
  const copyRoomCode = async () => {
    try {
      await navigator.clipboard.writeText(roomCode)

      setCopied(true)

      setTimeout(() => setCopied(false), 2000)

    } catch {
      alert(`Room code: ${roomCode}`)
    }
  }

  // COPY PREPARED QUESTION
  const copyExtractedQuestion = async () => {
    try {
      await navigator.clipboard.writeText(
        createClaudePrompt()
      )

      setCopied(true)

      setTimeout(() => setCopied(false), 2000)

    } catch {
      alert('Could not copy the question.')
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0612] text-white flex">

      {/* SIDEBAR */}
      <aside className="w-16 md:w-56 shrink-0 bg-[#120b1e] border-r border-purple-900/40 flex flex-col p-3 md:p-4">

        <div className="flex items-center gap-2 mb-10 px-1">
          <div className="w-9 h-9 rounded-xl bg-purple-600 flex items-center justify-center font-bold text-lg">
            E
          </div>

          <span className="hidden md:block text-xl font-bold">
            Emee<span className="text-purple-400">T</span>
          </span>
        </div>

        <nav className="space-y-2 flex-1">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-purple-600">
            <span>⌂</span>
            <span className="hidden md:block">Home</span>
          </div>

          <div className="flex items-center gap-3 p-3 rounded-xl text-gray-400">
            <span>◷</span>
            <span className="hidden md:block">Sessions</span>
          </div>

          <div className="flex items-center gap-3 p-3 rounded-xl text-gray-400">
            <span>⚙</span>
            <span className="hidden md:block">Settings</span>
          </div>
        </nav>

        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span className={`w-2 h-2 rounded-full ${
            status === 'live' ? 'bg-green-400' : 'bg-gray-500'
          }`} />

          <span className="hidden md:block">
            {status === 'live' ? 'Live' : 'Ready'}
          </span>
        </div>
      </aside>

      {/* MAIN DASHBOARD */}
      <main className="flex-1 min-w-0">

        <header className="h-16 border-b border-purple-900/30 flex items-center justify-between px-4 md:px-6">

          <div className="flex items-center gap-3">
            <h1 className="font-semibold">Dashboard</h1>

            {roomCode && (
              <button
                onClick={copyRoomCode}
                className="text-xs bg-[#241538] border border-purple-700/50 px-3 py-2 rounded-full text-purple-300"
              >
                Room: {roomCode} · Copy
              </button>
            )}
          </div>

          {!roomCode ? (
            <div className="flex gap-2">
              <button
                onClick={handleStartCall}
                className="bg-purple-600 hover:bg-purple-500 px-3 py-2 rounded-lg text-sm"
              >
                Start Session
              </button>

              <button
                onClick={() => setShowJoinModal(true)}
                className="bg-[#241538] px-3 py-2 rounded-lg text-sm"
              >
                Join
              </button>
            </div>
          ) : (
            <span className="text-xs text-green-400">
              ● {isHost ? 'Host' : 'Connected'} · {joiners.length} connected
            </span>
          )}
        </header>

        <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">

          {/* ROOM CONNECTION */}
          {roomCode && isHost && (
            <section className="bg-purple-600/20 border border-purple-500/40 rounded-2xl p-5 flex flex-wrap justify-between items-center gap-3">

              <div>
                <h2 className="font-semibold">
                  Connect your phone
                </h2>

                <p className="text-sm text-purple-200 mt-1">
                  Enter this room code on your phone.
                </p>

                <p className="text-2xl font-mono tracking-widest mt-2">
                  {roomCode}
                </p>
              </div>

              <button
                onClick={copyRoomCode}
                className="bg-purple-600 px-4 py-3 rounded-xl"
              >
                {copied ? 'Copied!' : 'Copy Code'}
              </button>
            </section>
          )}

          {/* SCREEN SHARING */}
          <section className="bg-[#1a102a] border border-purple-500/20 rounded-2xl p-5">

            <div className="flex flex-wrap items-center justify-between gap-4">

              <div>
                <h2 className="text-lg font-semibold">
                  Share Your Screen
                </h2>

                <p className="text-sm text-gray-400">
                  Share your entire screen, a window or a browser tab.
                </p>
              </div>

              {isHost && !isSharing && (
                <button
                  onClick={startScreenShare}
                  disabled={!roomCode}
                  className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 px-5 py-3 rounded-xl"
                >
                  Start Sharing
                </button>
              )}

              {isHost && isSharing && (
                <button
                  onClick={stopScreenShare}
                  className="bg-red-600 hover:bg-red-500 px-5 py-3 rounded-xl"
                >
                  Stop Sharing
                </button>
              )}

            </div>

            {!roomCode && (
              <p className="text-amber-400 text-sm mt-4">
                Create a session before sharing your screen.
              </p>
            )}

          </section>

          {/* SCREEN AND QUESTION */}
          {(isSharing || remoteStream) && (
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">

              {/* LIVE SCREEN */}
              <div className="bg-[#1a102a] border border-purple-500/20 rounded-2xl p-5">

                <div className="flex items-center gap-2 mb-4">
                  <span className="w-2.5 h-2.5 rounded-full bg-green-400 animate-pulse" />

                  <h3 className="font-semibold">
                    Screen (Live)
                  </h3>
                </div>

                <div
                  className={`relative aspect-video bg-black rounded-xl overflow-hidden border border-purple-900/50 ${isSelectingCrop ? 'cursor-crosshair touch-none' : ''}`}
                  onPointerDown={startCropSelection}
                  onPointerMove={moveCropSelection}
                  onPointerUp={finishCropSelection}
                  onPointerCancel={finishCropSelection}
                >

                  {isHost ? (
                    <video
                      ref={videoRef}
                      autoPlay
                      muted
                      playsInline
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <video
                      ref={remoteVideoRef}
                      autoPlay
                      playsInline
                      className="w-full h-full object-contain"
                    />
                  )}

                  {(cropRect || cropDraft) && (
                    <div
                      className="absolute border-2 border-cyan-400 bg-cyan-400/15 pointer-events-none"
                      style={{
                        left: `${(cropDraft || cropRect).x}%`,
                        top: `${(cropDraft || cropRect).y}%`,
                        width: `${(cropDraft || cropRect).width}%`,
                        height: `${(cropDraft || cropRect).height}%`
                      }}
                    />
                  )}

                  {isSelectingCrop && (
                    <div className="absolute inset-x-0 top-0 bg-black/65 text-center text-xs text-white py-2 pointer-events-none">Drag over the question area, then release</div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2 mt-3">
                  <button
                    onClick={() => { setIsSelectingCrop(true); setCropDraft(null) }}
                    className={`flex-1 min-w-[130px] border px-3 py-2 rounded-lg text-sm ${isSelectingCrop ? 'border-cyan-400 text-cyan-300' : 'border-purple-800 text-gray-300'}`}
                  >
                    Select Question Area
                  </button>
                  {cropRect && (
                    <button onClick={() => setCropRect(null)} className="border border-purple-800 px-3 py-2 rounded-lg text-sm text-gray-300">Clear Crop</button>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 mt-3 text-xs text-gray-400">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={autoDetect} onChange={e => setAutoDetect(e.target.checked)} className="accent-purple-500" />
                    Automatic detection (every 8 seconds)
                  </label>
                  {lastScanTime && <span>Last scan: {lastScanTime}</span>}
                </div>

                <button
                  onClick={() => scanScreen()}
                  disabled={isScanning}
                  className="w-full mt-4 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 py-3 rounded-xl font-medium"
                >
                  {isScanning
                    ? `Scanning Screen... ${ocrProgress}%`
                    : 'Scan Screen'}
                </button>

                {isScanning && (
                  <div className="mt-3 bg-[#120b1e] rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-purple-500 h-full transition-all"
                      style={{
                        width: `${ocrProgress}%`
                      }}
                    />
                  </div>
                )}

              </div>

              {/* QUESTION DETECTION */}
              <div className="bg-[#1a102a] border border-purple-500/20 rounded-2xl p-5 flex flex-col">

                <div className="flex items-center gap-2 text-purple-300 mb-4">
                  <span>✦</span>

                  <h3 className="font-semibold">
                    Question Detected
                  </h3>
                </div>

                {ocrError && (
                  <p className="text-red-400 text-sm mb-3">
                    {ocrError}
                  </p>
                )}

                {extractedQuestion ? (
                  <>
                    <div className="bg-[#120b1e] rounded-xl p-4 border border-purple-800/40">

                      <p className="text-xs text-purple-300 mb-3">
                        EXTRACTED QUESTION
                      </p>

                      <p className="font-medium leading-relaxed">
                        {extractedQuestion.question}
                      </p>

                      {extractedQuestion.options.length > 0 && (
                        <div className="mt-4 space-y-2">

                          <p className="text-xs text-purple-300">
                            ANSWER OPTIONS
                          </p>

                          {extractedQuestion.options.map(
                            (option, index) => (
                              <p
                                key={index}
                                className="text-sm text-gray-300"
                              >
                                {option}
                              </p>
                            )
                          )}

                        </div>
                      )}

                    </div>

                    <button
                      onClick={() => setShowClaudeConfirmation(true)}
                      className="mt-4 bg-purple-600 hover:bg-purple-500 py-3 rounded-xl font-medium"
                    >
                      Send to Claude
                    </button>

                    <button
                      onClick={copyExtractedQuestion}
                      className="mt-2 border border-purple-800 py-3 rounded-xl text-sm"
                    >
                      Copy Prepared Message
                    </button>
                  </>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-center py-8">

                    <div className="text-purple-400 text-4xl mb-4">
                      ✦
                    </div>

                    <h3 className="font-medium">
                      Waiting for a question
                    </h3>

                    <p className="text-sm text-gray-500 max-w-xs mt-2">
                      EmeeT will check the live screen automatically. You can also select a specific area and scan it manually.
                    </p>

                  </div>
                )}

              </div>
            </section>
          )}

          {/* WELCOME */}
          {!roomCode && (
            <section className="bg-[#1a102a] border border-purple-500/20 rounded-2xl p-10 text-center">

              <div className="w-16 h-16 mx-auto rounded-2xl bg-purple-600 flex items-center justify-center text-2xl font-bold mb-5">
                E
              </div>

              <h2 className="text-2xl font-bold">
                Welcome to EmeeT
              </h2>

              <p className="text-gray-400 mt-2">
                Share your screen, connect your phone and extract questions.
              </p>

              <button
                onClick={handleStartCall}
                className="mt-6 bg-purple-600 hover:bg-purple-500 px-6 py-3 rounded-xl"
              >
                Create a Session
              </button>

            </section>
          )}

        </div>
      </main>

      {/* JOIN MODAL */}
      {showJoinModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">

          <div className="bg-[#1a102a] border border-purple-500/30 rounded-2xl p-6 w-full max-w-sm">

            <h2 className="text-xl font-semibold">
              Join EmeeT Session
            </h2>

            <p className="text-sm text-gray-400 mt-2">
              Enter the room code displayed on the laptop.
            </p>

            <input
              value={joinCode}
              onChange={e =>
                setJoinCode(e.target.value.toUpperCase())
              }
              placeholder="ENTER CODE"
              maxLength={8}
              className="w-full mt-5 bg-[#120b1e] border border-purple-800 rounded-xl p-4 text-center font-mono tracking-widest outline-none focus:border-purple-500"
            />

            <div className="flex gap-3 mt-5">

              <button
                onClick={() => setShowJoinModal(false)}
                className="flex-1 bg-[#241538] rounded-xl p-3"
              >
                Cancel
              </button>

              <button
                onClick={handleJoin}
                className="flex-1 bg-purple-600 rounded-xl p-3"
              >
                Connect
              </button>

            </div>
          </div>
        </div>
      )}

      {/* CLAUDE CONFIRMATION */}
      {showClaudeConfirmation && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">

          <div className="bg-[#1a102a] border border-purple-500/30 rounded-2xl p-6 w-full max-w-md">

            <h2 className="text-xl font-semibold">
              Send to Claude?
            </h2>

            <p className="text-sm text-gray-400 mt-2">
              EmeeT will copy the prepared question and open Claude in a new tab.
            </p>

            <div className="bg-[#120b1e] border border-purple-800/40 rounded-xl p-4 mt-4 max-h-52 overflow-y-auto">

              <p className="text-sm whitespace-pre-wrap text-gray-200">
                {createClaudePrompt()}
              </p>

            </div>

            <div className="flex gap-3 mt-5">

              <button
                onClick={() => setShowClaudeConfirmation(false)}
                className="flex-1 bg-[#241538] rounded-xl p-3"
              >
                Cancel
              </button>

              <button
                onClick={sendToClaude}
                className="flex-1 bg-purple-600 hover:bg-purple-500 rounded-xl p-3"
              >
                Yes, Send to Claude
              </button>

            </div>
          </div>
        </div>
      )}

    </div>
  )
}

export default App
