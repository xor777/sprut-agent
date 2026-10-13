// One button opens a speech-to-speech conversation with OpenAI Realtime over
// WebRTC. The model's tool calls arrive on the data channel; the page runs
// them through the local server and returns the results to the model.
const statusElement = document.getElementById("status");
const hintElement = document.getElementById("hint");
const button = document.getElementById("talk");
const logElement = document.getElementById("log");

const TOKEN_KEY = "sprut-voice-token";
const VOICE_KEY = "sprut-voice-voice";
const IDLE_HANGUP_MS = 45_000;
const ENDING_GRACE_MS = 8_000;
const STATES = {
  idle: ["Нажмите и говорите", ""],
  connecting: ["Подключаюсь…", ""],
  listening: ["Слушаю", "Нажмите, чтобы закончить"],
  thinking: ["Думаю…", ""],
  working: ["Выполняю…", ""],
  speaking: ["Говорю", "Можно перебить"],
  ended: ["Разговор закончен", "Нажмите, чтобы поговорить ещё"],
  error: ["Не получилось", "Нажмите ещё раз"],
  no_token: [
    "Нужна ссылка-приглашение",
    "Откройте ссылку, которую вам прислали",
  ],
};

let token = readToken();
const voice = readVoice();
let session = null;

setState(token ? "idle" : "no_token");
navigator.serviceWorker?.register("/sw.js").catch(() => {});
button.addEventListener("click", () => {
  if (session) stop("ended");
  else start();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && session) stop("ended");
});

async function start() {
  token = readToken();
  if (!token) return setState("no_token");
  const current = { calls: new Map(), speaking: false, ending: false };
  // Created inside the tap, as mobile browsers require, and only measures.
  current.meter = createMeter();
  session = current;
  logElement.replaceChildren();
  setState("connecting");
  try {
    const [stream, minted] = await Promise.all([
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }),
      api("/api/session", voice ? { voice } : {}),
    ]);
    current.stream = stream;
    current.meter?.attach("input", stream);
    if (session !== current) return release(current);

    const pc = new RTCPeerConnection();
    current.pc = pc;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    current.audio = audio;
    pc.addEventListener("track", (event) => {
      audio.srcObject = event.streams[0];
      current.meter?.attach("output", event.streams[0]);
      audio.play().catch(() => {});
    });
    pc.addEventListener("connectionstatechange", () => {
      if (session !== current) return;
      if (["failed", "closed"].includes(pc.connectionState)) {
        stop("error", "Связь прервалась");
      }
    });
    pc.addTrack(stream.getAudioTracks()[0], stream);

    const channel = pc.createDataChannel("oai-events");
    current.channel = channel;
    channel.addEventListener("open", () => {
      if (session !== current) return;
      send(current, {
        type: "response.create",
        response: {
          instructions:
            "Коротко, в два-три слова, дай понять, что слушаешь. Например: «Да, слушаю».",
        },
      });
      setState("listening");
      armIdle(current);
    });
    channel.addEventListener("message", (event) => {
      if (session === current) onEvent(current, JSON.parse(event.data));
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answer = await fetch(minted.calls_url, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${minted.key}`,
        "Content-Type": "application/sdp",
      },
    });
    if (!answer.ok) {
      throw new Error(
        `OpenAI ${answer.status}: ${(await answer.text()).slice(0, 200)}`,
      );
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await answer.text() });
    navigator.wakeLock
      ?.request("screen")
      .then((lock) => {
        current.wakeLock = lock;
      })
      .catch(() => {});
  } catch (error) {
    remoteLog("error", error.message);
    if (session !== current) return;
    if (error.code === "unauthorized") return stop("no_token");
    if (error.name === "NotAllowedError") {
      return stop("error", "Разрешите доступ к микрофону");
    }
    stop("error", error.message);
  }
}

function onEvent(current, event) {
  switch (event.type) {
    case "input_audio_buffer.speech_started":
      current.userSpeaking = true;
      setState("listening");
      armIdle(current);
      break;
    case "input_audio_buffer.speech_stopped":
      current.userSpeaking = false;
      setState("thinking");
      break;
    case "output_audio_buffer.started":
      current.speaking = true;
      setState("speaking");
      break;
    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared":
      current.speaking = false;
      if (current.ending) return stop("ended");
      if (current.calls.size === 0) setState("listening");
      armIdle(current);
      break;
    case "response.function_call_arguments.done":
      startCall(current, event);
      break;
    case "response.done":
      finishResponse(current, event.response);
      break;
    case "conversation.item.input_audio_transcription.completed":
      addLine("user", event.transcript);
      break;
    case "response.output_audio_transcript.done":
      addLine("assistant", event.transcript);
      break;
    case "error":
      remoteLog("error", event.error?.message ?? JSON.stringify(event));
      break;
  }
}

// A call starts as soon as its arguments are complete, while the model may
// still be saying its short preamble; results go back after response.done.
function startCall(current, { call_id: callId, name, arguments: args }) {
  if (!callId || current.calls.has(callId)) return;
  if (name === "end_conversation") {
    remoteLog("tool", "end_conversation");
    current.ending = true;
    current.calls.set(callId, Promise.resolve({ status: "ok" }));
    setTimeout(() => {
      if (session === current) stop("ended");
    }, ENDING_GRACE_MS);
    return;
  }
  setState("working");
  let parsed = {};
  try {
    parsed = JSON.parse(args || "{}");
  } catch {}
  current.calls.set(
    callId,
    api("/api/tool", { name, arguments: parsed })
      .then(({ output }) => output)
      .catch((error) => ({
        status: "error",
        problem: "Не удалось связаться с домом. Ничего не подтверждено.",
        detail: error.message,
      })),
  );
}

async function finishResponse(current, response) {
  const calls = (response?.output ?? []).filter(
    (item) => item.type === "function_call",
  );
  if (calls.length === 0) return;
  for (const item of calls) startCall(current, item);
  const outputs = await Promise.all(
    calls.map(async (item) => [
      item.call_id,
      await current.calls.get(item.call_id),
    ]),
  );
  if (session !== current) return;
  for (const [callId, output] of outputs) {
    send(current, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    });
    current.calls.delete(callId);
  }
  if (calls.every((item) => item.name === "end_conversation")) {
    if (!current.speaking) stop("ended");
    return;
  }
  setState("thinking");
  send(current, { type: "response.create" });
}

// Ends a forgotten conversation, so an open screen does not keep a paid
// session listening to the room.
function armIdle(current) {
  clearTimeout(current.idle);
  current.idle = setTimeout(() => {
    if (session !== current) return;
    if (current.speaking || current.userSpeaking || current.calls.size > 0) {
      return armIdle(current);
    }
    stop("ended");
  }, IDLE_HANGUP_MS);
}

function stop(state, detail) {
  const current = session;
  session = null;
  if (current) release(current);
  setState(state, detail);
}

function release(current) {
  clearTimeout(current.idle);
  current.channel?.close();
  current.pc?.close();
  for (const track of current.stream?.getTracks() ?? []) track.stop();
  if (current.audio) current.audio.srcObject = null;
  current.wakeLock?.release().catch(() => {});
  current.meter?.stop();
}

function send(current, event) {
  if (current.channel?.readyState === "open") {
    current.channel.send(JSON.stringify(event));
  }
}

async function api(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.status === 204) return {};
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message ?? `Ошибка ${response.status}`);
    error.code = data.error?.code;
    if (error.code === "unauthorized") {
      try {
        localStorage.removeItem(TOKEN_KEY);
      } catch {}
      token = null;
    }
    throw error;
  }
  return data;
}

function remoteLog(type, text) {
  if (!token || !text) return;
  api("/api/log", { events: [{ type, text }] }).catch(() => {});
}

function addLine(role, text) {
  if (!text?.trim()) return;
  remoteLog(role, text);
  const line = document.createElement("p");
  line.className = role;
  line.textContent = role === "user" ? `Вы: ${text}` : text;
  logElement.append(line);
  while (logElement.childElementCount > 6)
    logElement.firstElementChild.remove();
}

function setState(state, detail) {
  const [title, hint] = STATES[state];
  document.body.dataset.state = state;
  statusElement.textContent = title;
  hintElement.textContent = detail ?? hint;
  button.setAttribute(
    "aria-label",
    session ? "Закончить разговор" : "Поговорить",
  );
}

// The invite link carries the access key in its fragment, which never
// reaches a server log; the page keeps it and removes it from the address.
function readToken() {
  const match = /(?:^#|&)k=([^&]+)/.exec(location.hash);
  if (match) {
    const value = decodeURIComponent(match[1]);
    history.replaceState(null, "", location.pathname + location.search);
    try {
      localStorage.setItem(TOKEN_KEY, value);
    } catch {}
    return value;
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return token ?? null;
  }
}

// «/?voice=cedar» picks a built-in voice for this phone and keeps it; the
// server accepts only its own list and otherwise uses the default.
function readVoice() {
  const requested = new URLSearchParams(location.search).get("voice");
  if (requested !== null) {
    history.replaceState(null, "", location.pathname + location.hash);
    try {
      if (requested) localStorage.setItem(VOICE_KEY, requested);
      else localStorage.removeItem(VOICE_KEY);
    } catch {}
    return requested || null;
  }
  try {
    return localStorage.getItem(VOICE_KEY);
  } catch {
    return null;
  }
}

// Loudness of the person and of the assistant drives the orb and the little
// house's mouth through --level and --mouth. Nothing is played through it.
function createMeter() {
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (!Context) return null;
  const context = new Context();
  const silent = context.createGain();
  silent.gain.value = 0;
  silent.connect(context.destination);
  const analysers = {};
  const samples = new Uint8Array(512);
  const root = document.documentElement.style;
  let level = 0;
  let mouth = 0;
  let frame = 0;
  const loudness = (analyser) => {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
    return Math.sqrt(sum / samples.length);
  };
  const tick = () => {
    const output = Math.min(1, loudness(analysers.output) * 5);
    const input = Math.min(1, loudness(analysers.input) * 4);
    level += (Math.max(output, input * 0.7) - level) * 0.3;
    mouth += (output - mouth) * 0.45;
    root.setProperty("--level", level.toFixed(3));
    root.setProperty("--mouth", mouth.toFixed(3));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return {
    attach(kind, stream) {
      try {
        const analyser = context.createAnalyser();
        analyser.fftSize = samples.length;
        context.createMediaStreamSource(stream).connect(analyser);
        analyser.connect(silent);
        analysers[kind] = analyser;
        context.resume().catch(() => {});
      } catch {}
    },
    stop() {
      cancelAnimationFrame(frame);
      root.setProperty("--level", "0");
      root.setProperty("--mouth", "0");
      context.close().catch(() => {});
    },
  };
}
