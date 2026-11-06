const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;
const ESP_KEY = process.env.ESP_KEY || "esp1234";
const PAGE_PASSWORD = process.env.PAGE_PASSWORD || "";
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";                 // sujet de notification (ntfy)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";   // clé pour détecter les personnes

const INTERVAL_MS = 30000;        // photo automatique toutes les 30 s
const NOTIF_COOLDOWN_MS = 60000;  // au plus 1 notification par minute

let pendingCaptures = [];
let captureSent = false;
let autoPending = false;          // photo automatique demandée
let autoTimeout = null;
let toEsp = [];
let fromEsp = [];
let lastSeen = 0;
let lastPhoto = null;             // dernière photo reçue
let lastResult = "aucune analyse";
let lastNotif = 0;

// ---------- Mot de passe optionnel (pas pour /api/esp/...) ----------
app.use((req, res, next) => {
  if (!PAGE_PASSWORD || req.path.startsWith("/api/esp/")) return next();
  const h = req.headers.authorization || "";
  const [scheme, b64] = h.split(" ");
  if (scheme === "Basic" && b64) {
    const pass = Buffer.from(b64, "base64").toString().split(":").slice(1).join(":");
    if (pass === PAGE_PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="ESP32-CAM"').status(401).send("Password required");
});

function checkKey(req, res) {
  if (req.headers["x-api-key"] !== ESP_KEY) {
    res.status(401).send("bad key");
    return false;
  }
  return true;
}

// ---------- Demande automatique d'une photo toutes les 30 s ----------
setInterval(() => {
  const espOnline = Date.now() - lastSeen < 15000;
  if (!espOnline || autoPending || captureSent) return;
  autoPending = true;
  clearTimeout(autoTimeout);
  autoTimeout = setTimeout(() => {      // pas de photo reçue : on annule
    autoPending = false;
    captureSent = false;
  }, 25000);
  console.log("Photo automatique demandée");
}, INTERVAL_MS);

// ---------- Détection de personne + notification ----------
async function hasPerson(jpeg) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 5,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
          { type: "text", text: "Is there a human being (a person, even partially visible) in this image? Answer only YES or NO." },
        ],
      }],
    }),
  });
  if (!r.ok) throw new Error("API " + r.status + " " + (await r.text()));
  const j = await r.json();
  return (j.content?.[0]?.text || "").trim().toUpperCase().startsWith("YES");
}

async function notify(jpeg) {
  if (!NTFY_TOPIC) return;
  await fetch("https://ntfy.sh/" + NTFY_TOPIC, {
    method: "PUT",
    headers: {
      Filename: "photo.jpg",
      Title: "Alerte : personne detectee",
      Message: "Une personne a ete detectee par l'ESP32-CAM",
      Tags: "warning",
      Priority: "high",
    },
    body: jpeg,
  });
}

async function analyze(jpeg) {
  if (!ANTHROPIC_API_KEY) { lastResult = "ANTHROPIC_API_KEY manquante"; return; }
  try {
    const person = await hasPerson(jpeg);
    lastResult = (person ? "PERSONNE détectée" : "personne") + " - " + new Date().toISOString();
    console.log("Analyse:", lastResult);
    if (person && Date.now() - lastNotif > NOTIF_COOLDOWN_MS) {
      lastNotif = Date.now();
      fromEsp.push("⚠️ Personne détectée !");
      await notify(jpeg);
    }
  } catch (e) {
    lastResult = "erreur analyse";
    console.log("Erreur analyse:", e.message);
  }
}

// =====================================================
// CÔTÉ ESP32
// =====================================================
app.get("/api/esp/poll", (req, res) => {
  if (!checkKey(req, res)) return;
  lastSeen = Date.now();

  let c = 0;
  if ((pendingCaptures.length > 0 || autoPending) && !captureSent) {
    c = 1;
    captureSent = true;
  }
  const msgs = toEsp.join("\n");
  toEsp = [];
  res.type("text/plain").send(c + "\n" + msgs);
});

app.post("/api/esp/message", express.text({ type: "*/*", limit: "10kb" }), (req, res) => {
  if (!checkKey(req, res)) return;
  lastSeen = Date.now();
  const t = String(req.body || "").trim();
  if (t) fromEsp.push(t);
  res.send("ok");
});

app.post("/api/esp/photo", express.raw({ type: "image/jpeg", limit: "5mb" }), (req, res) => {
  if (!checkKey(req, res)) return;
  lastSeen = Date.now();

  autoPending = false;
  clearTimeout(autoTimeout);
  captureSent = false;
  lastPhoto = req.body;

  const list = pendingCaptures;
  pendingCaptures = [];
  list.forEach((p) => {
    clearTimeout(p.timer);
    p.res.set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
    p.res.send(req.body);
  });
  res.send("ok");

  analyze(req.body);   // détection en arrière-plan
});

// =====================================================
// CÔTÉ NAVIGATEUR
// =====================================================
app.get("/api/capture", (req, res) => {
  const item = { res };
  pendingCaptures.push(item);
  item.timer = setTimeout(() => {
    pendingCaptures = pendingCaptures.filter((p) => p !== item);
    if (pendingCaptures.length === 0 && !autoPending) captureSent = false;
    res.status(504).send("ESP32 ne répond pas (hors ligne ?)");
  }, 25000);
});

app.get("/api/send", (req, res) => {
  const msg = String(req.query.msg || "").replace(/[\r\n]+/g, " ").slice(0, 200);
  if (!msg) return res.status(400).send("Missing message");
  toEsp.push(msg);
  res.send("Message sent to ESP32");
});

app.get("/api/receive", (req, res) => {
  res.type("text/plain").send(fromEsp.shift() || "");
});

app.get("/api/status", (req, res) => {
  res.json({ online: Date.now() - lastSeen < 15000 });
});

// Dernière photo et dernier résultat d'analyse
app.get("/api/last.jpg", (req, res) => {
  if (!lastPhoto) return res.status(404).send("Aucune photo");
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store" }).send(lastPhoto);
});
app.get("/api/last", (req, res) => res.json({ result: lastResult }));

app.use(express.static("public"));

app.listen(PORT, () => console.log("Server running on port " + PORT));
