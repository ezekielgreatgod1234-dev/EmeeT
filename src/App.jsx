import { useState, useRef, useEffect } from 'react'
import Peer from 'peerjs'
import { createWorker } from 'tesseract.js'

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const PEER_PREFIX = 'emeet-'
const SCAN_INTERVAL_MS = 3000

// STUN finds a direct path between devices. TURN relays the video when the
// laptop and phone are on different networks (Wi-Fi vs mobile data), which is
// the most common reason a joining device sees a blank screen.
// The Open Relay servers below are a free public relay. For production, swap
// in your own TURN credentials (Metered, Twilio, Cloudflare...).
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
]

const PEER_OPTIONS = { debug: 1, config: { iceServers: ICE_SERVERS } }

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const generateCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

const normalize = text =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const wordSet = text =>
  new Set(normalize(text).split(' ').filter(word => word.length > 2))

// Jaccard similarity, used so small OCR differences do not look like a new question.
const similarity = (a, b) => {
  const setA = wordSet(a)
  const setB = wordSet(b)
  if (!setA.size || !setB.size) return 0
  let shared = 0
  setA.forEach(word => {
    if (setB.has(word)) shared++
  })
  return shared / (setA.size + setB.size - shared)
}

const buildPrompt = q =>
  `Give me the correct answer to this question and identify the correct option.\n\nQuestion:\n${q.question}${
    q.options.length ? `\n\nOptions:\n${q.options.join('\n')}` : ''
  }`

// Tiny grayscale thumbnail, used to skip OCR when the screen has not changed.
const fingerprint = canvas => {
  const w = 48
  const h = 27
  const small = document.createElement('canvas')
  small.width = w
  small.height = h
  const ctx = small.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(canvas, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) {
    out[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114
  }
  return out
}

const printDiff = (a, b) => {
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i])
  return total / a.length
}

// Raises the video bitrate and keeps text sharp instead of dropping resolution.
const tuneVideoSender = call => {
  let tries = 0
  const timer = setInterval(async () => {
    tries++
    const sender = call.peerConnection
      ?.getSenders?.()
      .find(item => item.track?.kind === 'video')

    if (sender) {
      clearInterval(timer)
      try {
        const params = sender.getParameters()
        if (!params.encodings || !params.encodings.length) {
          params.encodings = [{}]
        }
        params.encodings[0].maxBitrate = 2500000
        params.degradationPreference = 'maintain-resolution'
        await sender.setParameters(params)
      } catch {
        /* not supported in this browser */
      }
    } else if (tries > 20) {
      clearInterval(timer)
    }
  }, 250)
}

// QUESTION AND OPTION EXTRACTION
const extractQuestionAndOptions = text => {
  const lines = text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 1)

  const optionRegex = /^(?:\(?\s*[a-d]\s*[\).:]|\(?\s*[1-4]\s*[\).:])\s*/i

  const questionKeywords =
    /\?|^(what|which|who|where|when|why|how|find|calculate|determine|identify|select|choose|state|explain|define|give|write|complete|solve|evaluate|convert|list|name|describe|compute)\b/i

  const metadataRegex =
    /^(task|home|day|time|level|course|subject|question|candidate|duration|marks|score|previous|next|pause|submit|show hint)\b/i

  const optionStart = lines.findIndex(line => optionRegex.test(line))

  let question = ''
  let options = []

  if (optionStart !== -1) {
    const beforeOptions = lines.slice(0, optionStart)

    const candidates = beforeOptions.filter(
      line => line.length > 5 && !metadataRegex.test(line)
    )

    const likelyQuestions = candidates.filter(line => questionKeywords.test(line))

    question = likelyQuestions.length
      ? likelyQuestions[likelyQuestions.length - 1]
      : candidates[candidates.length - 1] || ''

    options = lines
      .slice(optionStart)
      .filter(line => optionRegex.test(line))
      .slice(0, 8)
      .map(line => line.trim())
  } else {
    const candidates = lines.filter(
      line =>
        line.length > 10 &&
        !metadataRegex.test(line) &&
        questionKeywords.test(line)
    )

    question = candidates[candidates.length - 1] || ''
  }

  return { question: question.trim(), options }
}

const scoreExtraction = result => {
  let points = 0
  if (result.question) points += Math.min(result.question.length, 150)
  points += result.options.length * 35
  return points
}

const STATUS_TEXT = {
  idle: 'Ready',
  creating: 'Starting...',
  connecting: 'Connecting...',
  waiting: 'Waiting for a device',
  live: 'Live'
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

function App() {
  // Session
  const [roomCode, setRoomCode] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [showJoinModal, setShowJoinModal] = useState(false)
  const [isHost, setIsHost] = useState(true)
  const [isSharing, setIsSharing] = useState(false)
  const [localStream, setLocalStream] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)
  const [joiners, setJoiners] = useState([])
  const [status, setStatus] = useState('idle')
  const [needsTap, setNeedsTap] = useState(false)
  const [toast, setToast] = useState('')
  const [copied, setCopied] = useState('')

  // Detection
  const [isScanning, setIsScanning] = useState(false)
  const [ocrProgress, setOcrProgress] = useState(0)
  const [ocrError, setOcrError] = useState('')
  const [extractedQuestion, setExtractedQuestion] = useState(null)
  const [autoDetect, setAutoDetect] = useState(true)
  const [isSelectingCrop, setIsSelectingCrop] = useState(false)
  const [cropRect, setCropRect] = useState(null)
  const [cropDraft, setCropDraft] = useState(null)
  const [lastScanTime, setLastScanTime] = useState('')

  // Refs
  const videoRef = useRef(null)
  const videoWrapRef = useRef(null)
  const peerRef = useRef(null)
  const localStreamRef = useRef(null)
  const connectionsRef = useRef(new Map()) // peerId -> DataConnection
  const callsRef = useRef(new Map()) // peerId -> MediaConnection
  const workerPromiseRef = useRef(null)
  const isScanningRef = useRef(false)
  const scanScreenRef = useRef(null)
  const cropStartRef = useRef(null)
  const lastPrintRef = useRef(null)
  const skipCountRef = useRef(0)
  const lastQuestionTextRef = useRef('')
  const toastTimerRef = useRef(null)
  const isHostRef = useRef(true)
  const latestQuestionRef = useRef(null)

  isHostRef.current = isHost
  latestQuestionRef.current = extractedQuestion

  const activeStream = isHost ? localStream : remoteStream
  const hasScreen = Boolean(activeStream)

  const notify = message => {
    setToast(message)
    clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(''), 4000)
  }

  const flashCopied = key => {
    setCopied(key)
    setTimeout(() => setCopied(''), 2000)
  }

  /* ---------------------------- effects ---------------------------- */

  // Attach the live screen (local on the host, remote on joiners).
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (video.srcObject !== activeStream) {
      video.srcObject = activeStream || null
    }

    if (activeStream) {
      const playing = video.play()
      if (playing?.then) {
        playing
          .then(() => setNeedsTap(false))
          .catch(error => {
            if (error.name !== 'AbortError') setNeedsTap(true)
          })
      }
    }
  }, [activeStream])

  // Keep the latest scanner available to the timer.
  useEffect(() => {
    scanScreenRef.current = scanScreen
  })

  // Reset change detection when the crop area changes.
  useEffect(() => {
    lastPrintRef.current = null
    skipCountRef.current = 0
  }, [cropRect])

  // Warm up OCR as soon as a screen is visible so the first scan is instant.
  useEffect(() => {
    if (hasScreen) getWorker().catch(() => {})
  }, [hasScreen])

  // Automatic detection (skips unchanged frames and hidden tabs).
  useEffect(() => {
    if (!autoDetect || !hasScreen) return

    const first = setTimeout(() => {
      scanScreenRef.current?.({ automatic: true })
    }, 1200)

    const timer = setInterval(() => {
      if (document.hidden || isScanningRef.current) return
      scanScreenRef.current?.({ automatic: true })
    }, SCAN_INTERVAL_MS)

    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [autoDetect, hasScreen])

  // A joining device keeps asking for the screen until it arrives.
  useEffect(() => {
    if (isHost || !roomCode || status !== 'live' || remoteStream) return

    const timer = setInterval(() => {
      const conn = connectionsRef.current.get('host')
      if (conn?.open) conn.send({ type: 'ready' })
    }, 8000)

    return () => clearInterval(timer)
  }, [isHost, roomCode, status, remoteStream])

  // Join links: https://your-site/?room=ABC123
  useEffect(() => {
    const room = new URLSearchParams(window.location.search).get('room')
    if (room) {
      setJoinCode(room.toUpperCase().slice(0, 8))
      setShowJoinModal(true)
    }
  }, [])

  // Cleanup when the app closes.
  useEffect(() => {
    return () => {
      localStreamRef.current?.getTracks().forEach(track => track.stop())
      callsRef.current.forEach(call => call.close())
      connectionsRef.current.forEach(conn => conn.close())
      peerRef.current?.destroy()
      workerPromiseRef.current?.then(worker => worker.terminate()).catch(() => {})
      clearTimeout(toastTimerRef.current)
    }
  }, [])

  /* ------------------------ connection helpers ------------------------ */

  const broadcast = message => {
    if (!isHostRef.current) return
    connectionsRef.current.forEach(conn => {
      if (conn.open) {
        try {
          conn.send(message)
        } catch {
          /* connection closing */
        }
      }
    })
  }

  // Host: send the screen to one joined device.
  const callJoiner = (peerId, force = false) => {
    const peer = peerRef.current
    const stream = localStreamRef.current
    if (!peer || !stream) return

    const existing = callsRef.current.get(peerId)
    if (!force && existing && Date.now() - existing._startedAt < 15000) return

    const call = peer.call(peerId, stream)
    if (!call) return

    call._startedAt = Date.now()
    callsRef.current.set(peerId, call)
    existing?.close()
    tuneVideoSender(call)

    call.on('close', () => {
      if (callsRef.current.get(peerId) === call) callsRef.current.delete(peerId)
    })
    call.on('error', error => console.error('Call error:', error))
  }

  const leaveSession = () => {
    const peer = peerRef.current
    peerRef.current = null // handlers check this to know the session is over

    localStreamRef.current?.getTracks().forEach(track => track.stop())
    localStreamRef.current = null

    callsRef.current.forEach(call => call.close())
    callsRef.current.clear()
    connectionsRef.current.forEach(conn => conn.close())
    connectionsRef.current.clear()
    peer?.destroy()

    setLocalStream(null)
    setRemoteStream(null)
    setIsSharing(false)
    setJoiners([])
    setRoomCode('')
    setIsHost(true)
    setAutoDetect(true)
    setStatus('idle')
    setExtractedQuestion(null)
    setOcrError('')
    setNeedsTap(false)
    lastPrintRef.current = null
    lastQuestionTextRef.current = ''
  }

  // Joiner receives detected questions sent by the host.
  const handleHostMessage = data => {
    if (!data || typeof data !== 'object') return

    if (data.type === 'question') {
      setExtractedQuestion(data.question || null)
    }

    if (data.type === 'stopped') {
      setRemoteStream(null)
    }
  }

  /* --------------------------- HOST: create --------------------------- */

  const startHost = (attempt = 0) => {
    if (peerRef.current) return

    const code = generateCode()

    setRoomCode(code)
    setIsHost(true)
    setAutoDetect(true)
    setStatus('creating')

    const peer = new Peer(PEER_PREFIX + code, PEER_OPTIONS)
    peerRef.current = peer

    peer.on('open', () => setStatus('waiting'))

    peer.on('connection', conn => {
      conn.on('open', () => {
        connectionsRef.current.set(conn.peer, conn)
        setJoiners(prev => (prev.includes(conn.peer) ? prev : [...prev, conn.peer]))
        setStatus('live')

        // Show the current question to a device that joins late.
        if (latestQuestionRef.current) {
          conn.send({ type: 'question', question: latestQuestionRef.current })
        }

        callJoiner(conn.peer)
      })

      conn.on('data', data => {
        if (data?.type === 'ready') callJoiner(conn.peer, Boolean(data.force))
      })

      const drop = () => {
        if (connectionsRef.current.get(conn.peer) === conn) {
          connectionsRef.current.delete(conn.peer)
        }
        callsRef.current.get(conn.peer)?.close()
        callsRef.current.delete(conn.peer)
        setJoiners(prev => prev.filter(id => id !== conn.peer))
        if (peerRef.current === peer && connectionsRef.current.size === 0) {
          setStatus('waiting')
        }
      }

      conn.on('close', drop)
      conn.on('error', drop)
    })

    peer.on('disconnected', () => {
      if (!peer.destroyed) peer.reconnect()
    })

    peer.on('error', error => {
      console.error('Peer error:', error)

      if (error.type === 'peer-unavailable') return

      if (error.type === 'unavailable-id' && attempt < 3) {
        peerRef.current = null
        peer.destroy()
        startHost(attempt + 1)
        return
      }

      if (peerRef.current === peer) {
        notify(`Connection error: ${error.type}`)
        leaveSession()
      }
    })
  }

  const handleStartCall = () => startHost(0)

  /* --------------------------- JOIN: connect --------------------------- */

  const handleJoin = () => {
    const code = joinCode.trim().toUpperCase()
    if (!code || peerRef.current) return

    setRoomCode(code)
    setIsHost(false)
    setAutoDetect(false) // the laptop detects; results are sent here
    setStatus('connecting')
    setShowJoinModal(false)

    const peer = new Peer(undefined, PEER_OPTIONS)
    peerRef.current = peer

    // Register the call listener immediately so the screen is never missed.
    peer.on('call', call => {
      call.answer()

      const previous = callsRef.current.get('host')
      callsRef.current.set('host', call)
      previous?.close()

      call.on('stream', stream => {
        setRemoteStream(stream)
        setStatus('live')
      })

      call.on('close', () => {
        if (callsRef.current.get('host') === call) setRemoteStream(null)
      })

      call.on('error', error => console.error('Stream error:', error))
    })

    peer.on('open', () => {
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true })
      connectionsRef.current.set('host', conn)

      const timeout = setTimeout(() => {
        if (peerRef.current === peer && !conn.open) {
          notify('Could not reach the host. Check the code and that the session is active.')
          leaveSession()
        }
      }, 20000)

      conn.on('open', () => {
        clearTimeout(timeout)
        setStatus('live')
        setJoiners([code])
        conn.send({ type: 'ready' })
      })

      conn.on('data', handleHostMessage)

      conn.on('close', () => {
        clearTimeout(timeout)
        if (peerRef.current === peer) {
          notify('The host ended the session.')
          leaveSession()
        }
      })

      conn.on('error', error => {
        console.error(error)
        clearTimeout(timeout)
        if (peerRef.current === peer) {
          notify('Unable to connect. Check the room code.')
          leaveSession()
        }
      })
    })

    peer.on('disconnected', () => {
      if (!peer.destroyed) peer.reconnect()
    })

    peer.on('error', error => {
      console.error(error)

      if (peerRef.current !== peer) return

      if (error.type === 'peer-unavailable') {
        notify('Room not found. Check the code and that the laptop session is active.')
        leaveSession()
      } else if (error.type === 'network' || error.type === 'server-error') {
        notify('Network problem. Retrying...')
      }
    })
  }

  const requestScreen = () => {
    const conn = connectionsRef.current.get('host')
    if (conn?.open) {
      conn.send({ type: 'ready', force: true })
      notify('Asked the laptop to resend the screen.')
    } else {
      notify('Not connected to the host yet.')
    }
  }

  /* ------------------------- screen sharing ------------------------- */

  const startScreenShare = async () => {
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        notify('Screen sharing needs a supported browser on a secure (https) connection.')
        return
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false
      })

      const track = stream.getVideoTracks()[0]
      if (track && 'contentHint' in track) track.contentHint = 'detail'

      localStreamRef.current = stream
      setLocalStream(stream)
      setIsSharing(true)
      setStatus('live')
      setExtractedQuestion(null)
      setOcrError('')
      lastPrintRef.current = null
      lastQuestionTextRef.current = ''

      // Send the screen to every connected device.
      connectionsRef.current.forEach((conn, peerId) => {
        if (conn.open) callJoiner(peerId, true)
      })

      track?.addEventListener('ended', stopScreenShare, { once: true })
    } catch (error) {
      console.error('Screen sharing error:', error)
      if (error.name !== 'NotAllowedError') {
        notify('Unable to start screen sharing.')
      }
    }
  }

  const stopScreenShare = () => {
    localStreamRef.current?.getTracks().forEach(track => track.stop())
    localStreamRef.current = null

    callsRef.current.forEach(call => call.close())
    callsRef.current.clear()

    broadcast({ type: 'stopped' })

    setLocalStream(null)
    setIsSharing(false)
    setExtractedQuestion(null)
    setOcrError('')

    setStatus(
      peerRef.current ? (connectionsRef.current.size ? 'live' : 'waiting') : 'idle'
    )
  }

  const goFullscreen = () => {
    const wrap = videoWrapRef.current
    const video = videoRef.current

    if (wrap?.requestFullscreen) {
      wrap.requestFullscreen().catch(() => {})
    } else if (video?.webkitEnterFullscreen) {
      video.webkitEnterFullscreen() // iPhone Safari
    }
  }

  /* ------------------------------ OCR ------------------------------ */

  const getWorker = () => {
    if (!workerPromiseRef.current) {
      workerPromiseRef.current = createWorker('eng', 1, {
        logger: message => {
          if (message.status === 'recognizing text') {
            setOcrProgress(Math.round(message.progress * 100))
          }
        }
      })
        .then(async worker => {
          await worker.setParameters({ preserve_interword_spaces: '1' })
          return worker
        })
        .catch(error => {
          workerPromiseRef.current = null
          throw error
        })
    }
    return workerPromiseRef.current
  }

  // Draws only the needed part of the video (full screen or the chosen area).
  const captureScreenFrame = () => {
    const video = videoRef.current

    if (!video || !video.srcObject) {
      throw new Error('No shared screen is available.')
    }

    if (!video.videoWidth || !video.videoHeight) {
      throw new Error('Screen preview is not ready. Try again.')
    }

    let sx = 0
    let sy = 0
    let sw = video.videoWidth
    let sh = video.videoHeight

    if (cropRect) {
      sx = Math.max(0, Math.round((video.videoWidth * cropRect.x) / 100))
      sy = Math.max(0, Math.round((video.videoHeight * cropRect.y) / 100))
      sw = Math.max(1, Math.min(video.videoWidth - sx, Math.round((video.videoWidth * cropRect.width) / 100)))
      sh = Math.max(1, Math.min(video.videoHeight - sy, Math.round((video.videoHeight * cropRect.height) / 100)))
    }

    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    canvas
      .getContext('2d', { willReadFrequently: true })
      .drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)

    return canvas
  }

  // Grayscale + contrast, inverts dark themes, and scales to a good OCR size.
  const preprocessImage = source => {
    const target = cropRect ? 1600 : 2000
    const scale = Math.min(3, Math.max(0.5, target / source.width))

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(source.width * scale))
    canvas.height = Math.max(1, Math.round(source.height * scale))

    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(source, 0, 0, canvas.width, canvas.height)

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
    const pixels = imageData.data

    let sum = 0
    let count = 0
    for (let i = 0; i < pixels.length; i += 148) {
      sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
      count++
    }
    const invert = sum / count < 110

    for (let i = 0; i < pixels.length; i += 4) {
      let gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
      if (invert) gray = 255 - gray
      gray = Math.max(0, Math.min(255, (gray - 128) * 1.6 + 128))
      pixels[i] = gray
      pixels[i + 1] = gray
      pixels[i + 2] = gray
    }

    context.putImageData(imageData, 0, 0)
    return canvas
  }

  const scanScreen = async ({ automatic = false } = {}) => {
    if (isScanningRef.current) return
    if (!automatic) setOcrError('')

    try {
      isScanningRef.current = true

      const frame = captureScreenFrame()

      // Skip OCR when nothing on screen changed (automatic scans only).
      const print = fingerprint(frame)
      const previous = lastPrintRef.current
      lastPrintRef.current = print

      if (
        automatic &&
        previous &&
        printDiff(previous, print) < 1.2 &&
        skipCountRef.current < 6
      ) {
        skipCountRef.current++
        return
      }
      skipCountRef.current = 0

      setIsScanning(true)
      setOcrProgress(0)

      const worker = await getWorker()
      const enhanced = preprocessImage(frame)

      // Pass 1: text block.
      await worker.setParameters({ tessedit_pageseg_mode: '6' })
      const first = await worker.recognize(enhanced)
      let best = extractQuestionAndOptions(first.data.text)

      // Pass 2 only when pass 1 found nothing: scattered text.
      if (!best.question) {
        await worker.setParameters({ tessedit_pageseg_mode: '11' })
        const second = await worker.recognize(enhanced)
        const alt = extractQuestionAndOptions(second.data.text)
        if (scoreExtraction(alt) > scoreExtraction(best)) best = alt
      }

      if (!best.question) {
        if (!automatic) {
          setOcrError(
            'No clear question was found. Try selecting the question area and scanning again.'
          )
        }
        return
      }

      handleDetected(best)
    } catch (error) {
      console.error('OCR error:', error)
      if (!automatic) setOcrError(error.message || 'Unable to scan the screen.')
    } finally {
      isScanningRef.current = false
      setIsScanning(false)
    }
  }

  const handleDetected = found => {
    setLastScanTime(new Date().toLocaleTimeString())
    setOcrError('')

    const text = `${found.question} ${found.options.join(' ')}`
    const isSame =
      lastQuestionTextRef.current &&
      similarity(lastQuestionTextRef.current, text) > 0.8

    if (isSame) return // same question, keep what is already shown

    lastQuestionTextRef.current = text
    setExtractedQuestion(found)
    broadcast({ type: 'question', question: found })
  }

  /* ----------------------------- Claude ----------------------------- */

  // Copies the prepared question and opens Claude in a new tab.
  const askClaude = async () => {
    if (!extractedQuestion?.question) return

    // Open synchronously from the click so the browser does not block the tab.
    const claudeWindow = window.open('https://claude.ai/new', '_blank')

    try {
      await navigator.clipboard.writeText(buildPrompt(extractedQuestion))
      flashCopied('ask')
      notify(
        claudeWindow
          ? 'Question copied. Paste it into Claude.'
          : 'Question copied. Open Claude and paste it.'
      )
    } catch (error) {
      console.error('Clipboard error:', error)
      notify('Could not copy the question. Allow clipboard access and try again.')
    }
  }

  const copyText = async (text, key, failMessage) => {
    try {
      await navigator.clipboard.writeText(text)
      flashCopied(key)
    } catch {
      notify(failMessage)
    }
  }

  /* ------------------------- crop selection ------------------------- */

  const pointFromEvent = event => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100)),
      y: Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100))
    }
  }

  const startCropSelection = event => {
    if (!isSelectingCrop) return
    const point = pointFromEvent(event)
    cropStartRef.current = point
    setCropDraft({ ...point, width: 0, height: 0 })
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const moveCropSelection = event => {
    if (!isSelectingCrop || !cropStartRef.current) return
    const point = pointFromEvent(event)
    const start = cropStartRef.current
    setCropDraft({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y)
    })
  }

  const finishCropSelection = () => {
    if (!cropStartRef.current) return
    if (cropDraft && cropDraft.width > 1 && cropDraft.height > 1) {
      setCropRect(cropDraft)
    }
    setCropDraft(null)
    cropStartRef.current = null
    setIsSelectingCrop(false)
  }

  /* ------------------------------ render ------------------------------ */

  const joinLink = roomCode
    ? `${window.location.origin}${window.location.pathname}?room=${roomCode}`
    : ''

  const shownCrop = cropDraft || cropRect

  return (
    <div className="min-h-screen bg-[#0a0612] text-white flex">

      {/* SIDEBAR (tablet and desktop) */}
      <aside className="hidden sm:flex w-16 md:w-56 shrink-0 bg-[#120b1e] border-r border-purple-900/40 flex-col p-3 md:p-4">

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
          <span className={`w-2 h-2 rounded-full ${status === 'live' ? 'bg-green-400' : 'bg-gray-500'}`} />
          <span className="hidden md:block">{STATUS_TEXT[status]}</span>
        </div>
      </aside>

      {/* MAIN */}
      <main className="flex-1 min-w-0">

        <header className="sticky top-0 z-30 bg-[#0a0612]/90 backdrop-blur border-b border-purple-900/30 flex flex-wrap items-center justify-between gap-2 px-3 sm:px-6 py-2 min-h-16">

          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="sm:hidden w-8 h-8 rounded-lg bg-purple-600 flex items-center justify-center font-bold">
              E
            </div>

            <h1 className="font-semibold hidden sm:block">Dashboard</h1>

            {roomCode && (
              <button
                onClick={() => copyText(roomCode, 'code', `Room code: ${roomCode}`)}
                className="text-xs bg-[#241538] border border-purple-700/50 px-3 py-2 rounded-full text-purple-300"
              >
                Room {roomCode} {copied === 'code' ? '· Copied' : '· Copy'}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {!roomCode ? (
              <>
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
              </>
            ) : (
              <>
                <span className="text-xs text-green-400 hidden sm:inline">
                  ● {isHost ? 'Host' : 'Viewer'} · {joiners.length} connected
                </span>
                <button
                  onClick={leaveSession}
                  className="border border-purple-800 px-3 py-2 rounded-lg text-sm text-gray-300"
                >
                  {isHost ? 'End' : 'Leave'}
                </button>
              </>
            )}
          </div>
        </header>

        <div className="max-w-6xl mx-auto p-3 sm:p-4 md:p-6 space-y-4 sm:space-y-6">

          {/* ROOM CONNECTION */}
          {roomCode && isHost && (
            <section className="bg-purple-600/20 border border-purple-500/40 rounded-2xl p-4 sm:p-5 flex flex-wrap justify-between items-center gap-3">
              <div>
                <h2 className="font-semibold">Connect your phone</h2>
                <p className="text-sm text-purple-200 mt-1">
                  Enter this code on your phone, or open the join link.
                </p>
                <p className="text-2xl font-mono tracking-widest mt-2">{roomCode}</p>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => copyText(roomCode, 'code', `Room code: ${roomCode}`)}
                  className="bg-purple-600 px-4 py-3 rounded-xl"
                >
                  {copied === 'code' ? 'Copied!' : 'Copy Code'}
                </button>
                <button
                  onClick={() => copyText(joinLink, 'link', joinLink)}
                  className="border border-purple-500/60 px-4 py-3 rounded-xl"
                >
                  {copied === 'link' ? 'Copied!' : 'Copy Link'}
                </button>
              </div>
            </section>
          )}

          {/* SCREEN SHARING */}
          {roomCode && (
            <section className="bg-[#1a102a] border border-purple-500/20 rounded-2xl p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">
                    {isHost ? 'Share Your Screen' : 'Host Screen'}
                  </h2>
                  <p className="text-sm text-gray-400">
                    {isHost
                      ? 'Share your entire screen, a window or a browser tab.'
                      : 'The shared screen appears below as soon as the laptop starts sharing.'}
                  </p>
                </div>

                {isHost && !isSharing && (
                  <button
                    onClick={startScreenShare}
                    className="bg-purple-600 hover:bg-purple-500 px-5 py-3 rounded-xl"
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

                {!isHost && !remoteStream && status === 'live' && (
                  <button
                    onClick={requestScreen}
                    className="border border-purple-500/60 px-5 py-3 rounded-xl"
                  >
                    Request Screen
                  </button>
                )}
              </div>

              {!isHost && !remoteStream && (
                <p className="text-amber-300 text-sm mt-4">
                  {status === 'live'
                    ? 'Connected. Waiting for the laptop to start sharing. If the screen does not appear within 15 seconds, tap Request Screen.'
                    : 'Connecting to the laptop...'}
                </p>
              )}
            </section>
          )}

          {/* SCREEN AND QUESTION */}
          {hasScreen && (
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">

              {/* LIVE SCREEN */}
              <div className="bg-[#1a102a] border border-purple-500/20 rounded-2xl p-3 sm:p-5">

                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-green-400 animate-pulse" />
                    <h3 className="font-semibold">Screen (Live)</h3>
                  </div>
                  <button
                    onClick={goFullscreen}
                    className="text-xs border border-purple-800 px-3 py-2 rounded-lg text-gray-300"
                  >
                    Full screen
                  </button>
                </div>

                <div
                  ref={videoWrapRef}
                  className={`relative aspect-video bg-black rounded-xl overflow-hidden border border-purple-900/50 ${isSelectingCrop ? 'cursor-crosshair touch-none' : ''}`}
                  onPointerDown={startCropSelection}
                  onPointerMove={moveCropSelection}
                  onPointerUp={finishCropSelection}
                  onPointerCancel={finishCropSelection}
                >
                  <video
                    ref={videoRef}
                    autoPlay
                    muted
                    playsInline
                    disablePictureInPicture
                    className="w-full h-full object-contain"
                  />

                  {needsTap && (
                    <button
                      onClick={() => videoRef.current?.play().then(() => setNeedsTap(false)).catch(() => {})}
                      className="absolute inset-0 bg-black/70 flex items-center justify-center text-lg font-medium"
                    >
                      Tap to show the screen
                    </button>
                  )}

                  {shownCrop && (
                    <div
                      className="absolute border-2 border-cyan-400 bg-cyan-400/15 pointer-events-none"
                      style={{
                        left: `${shownCrop.x}%`,
                        top: `${shownCrop.y}%`,
                        width: `${shownCrop.width}%`,
                        height: `${shownCrop.height}%`
                      }}
                    />
                  )}

                  {isSelectingCrop && (
                    <div className="absolute inset-x-0 top-0 bg-black/65 text-center text-xs text-white py-2 pointer-events-none">
                      Drag over the question area, then release
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2 mt-3">
                  <button
                    onClick={() => {
                      setIsSelectingCrop(true)
                      setCropDraft(null)
                    }}
                    className={`flex-1 min-w-[130px] border px-3 py-3 rounded-lg text-sm ${isSelectingCrop ? 'border-cyan-400 text-cyan-300' : 'border-purple-800 text-gray-300'}`}
                  >
                    Select Question Area
                  </button>
                  {cropRect && (
                    <button
                      onClick={() => setCropRect(null)}
                      className="border border-purple-800 px-3 py-3 rounded-lg text-sm text-gray-300"
                    >
                      Clear Crop
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 mt-3 text-xs text-gray-400">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoDetect}
                      onChange={e => setAutoDetect(e.target.checked)}
                      className="accent-purple-500 w-4 h-4"
                    />
                    Automatic detection
                  </label>
                  {lastScanTime && <span>Last scan: {lastScanTime}</span>}
                </div>

                {!isHost && !autoDetect && (
                  <p className="text-xs text-gray-500 mt-2">
                    The laptop detects questions and sends them here automatically. You can also scan from this device.
                  </p>
                )}

                <button
                  onClick={() => scanScreen()}
                  disabled={isScanning}
                  className="w-full mt-4 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 py-3 rounded-xl font-medium"
                >
                  {isScanning ? `Scanning... ${ocrProgress}%` : 'Scan Screen'}
                </button>

                {isScanning && (
                  <div className="mt-3 bg-[#120b1e] rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-purple-500 h-full transition-all"
                      style={{ width: `${ocrProgress}%` }}
                    />
                  </div>
                )}
              </div>

              {/* QUESTION DETECTION */}
              <div className="bg-[#1a102a] border border-purple-500/20 rounded-2xl p-4 sm:p-5 flex flex-col">

                <div className="flex items-center gap-2 text-purple-300 mb-4">
                  <span>✦</span>
                  <h3 className="font-semibold">Question Detected</h3>
                </div>

                {ocrError && (
                  <p className="text-red-400 text-sm mb-3">{ocrError}</p>
                )}

                {extractedQuestion ? (
                  <>
                    <div className="bg-[#120b1e] rounded-xl p-4 border border-purple-800/40">
                      <p className="text-xs text-purple-300 mb-3">EXTRACTED QUESTION</p>
                      <p className="font-medium leading-relaxed">{extractedQuestion.question}</p>

                      {extractedQuestion.options.length > 0 && (
                        <div className="mt-4 space-y-2">
                          <p className="text-xs text-purple-300">ANSWER OPTIONS</p>
                          {extractedQuestion.options.map((option, index) => (
                            <p key={index} className="text-sm text-gray-300">
                              {option}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>

                    <button
                      onClick={askClaude}
                      className="mt-4 bg-purple-600 hover:bg-purple-500 py-3 rounded-xl font-medium"
                    >
                      {copied === 'ask' ? 'Copied! Paste in Claude' : 'Ask Claude'}
                    </button>
                  </>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-center py-8">
                    <div className="text-purple-400 text-4xl mb-4">✦</div>
                    <h3 className="font-medium">Waiting for a question</h3>
                    <p className="text-sm text-gray-500 max-w-xs mt-2">
                      EmeeT checks the live screen automatically. You can also select an area and scan it manually.
                    </p>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* WELCOME */}
          {!roomCode && (
            <section className="bg-[#1a102a] border border-purple-500/20 rounded-2xl p-6 sm:p-10 text-center">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-purple-600 flex items-center justify-center text-2xl font-bold mb-5">
                E
              </div>

              <h2 className="text-2xl font-bold">Welcome to EmeeT</h2>

              <p className="text-gray-400 mt-2">
                Share your screen, connect your phone and extract questions.
              </p>

              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <button
                  onClick={handleStartCall}
                  className="bg-purple-600 hover:bg-purple-500 px-6 py-3 rounded-xl"
                >
                  Create a Session
                </button>
                <button
                  onClick={() => setShowJoinModal(true)}
                  className="bg-[#241538] px-6 py-3 rounded-xl"
                >
                  Join a Session
                </button>
              </div>
            </section>
          )}

        </div>
      </main>

      {/* JOIN MODAL */}
      {showJoinModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-[#1a102a] border border-purple-500/30 rounded-2xl p-6 w-full max-w-sm">
            <h2 className="text-xl font-semibold">Join EmeeT Session</h2>
            <p className="text-sm text-gray-400 mt-2">
              Enter the room code displayed on the laptop.
            </p>

            <input
              value={joinCode}
              onChange={e => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
              placeholder="ENTER CODE"
              maxLength={8}
              autoCapitalize="characters"
              autoComplete="off"
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

      {/* TOAST */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] max-w-[90vw] bg-purple-700 border border-purple-400/40 px-4 py-3 rounded-xl text-sm shadow-lg">
          {toast}
        </div>
      )}

    </div>
  )
}

export default App