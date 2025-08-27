import axios from "axios";
import readline from "readline";
import tough from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";

// ===================== KONFIGURASI =====================
// Host & endpoint
const BASE = "http://103.118.82.91";
const LOGIN_PAGE = "/login";
const LOGIN_ENDPOINT = "/login"; // endpoint POST login
const LIST_ENDPOINT = "/alumni/presuniv_events";

// Urutan kemungkinan endpoint booking (prioritaskan yang dipakai web)
const POSSIBLE_BOOK_ENDPOINTS = [
    "/alumni/presuniv_events",         // H.Post(...) biasanya ke ini
    "/alumni/presuniv_events/book",
    "/alumni/presuniv_events/reservation",
];

const NAME_KEYWORDS = ["PREUNI Final Night (Alumni)"]; // Target event keyword

// Mode payload booking: "json" atau "form"
const BOOK_PAYLOAD_MODE = "form";

// Tuning tembakan
const PARALLEL_SHOTS = 4;   // jumlah request paralel di detik 0 (jangan berlebihan)
const MAX_RETRIES = 4;      // retry untuk 429/5xx / error jaringan
const TIMEOUT_MS = 4000;    // timeout per request
const ARRIVE_EARLY_MS = 250;// datang ~250ms sebelum jam buka
const MICRO_POLL_MS = 10;   // presisi tunggu detik buka

// ===================== HTTP CLIENT (cookie jar) =====================
const jar = new tough.CookieJar();
const httpClient = wrapper(
    axios.create({
        baseURL: BASE,
        timeout: TIMEOUT_MS,
        withCredentials: true,
        jar,
        validateStatus: (s) => s >= 200 && s < 600,
        // Laravel XSRF defaults (kalau server set XSRF-TOKEN cookie)
        xsrfCookieName: "XSRF-TOKEN",
        xsrfHeaderName: "X-XSRF-TOKEN",
        headers: {
            "User-Agent": "PresUnivTicketBot/1.0",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Connection": "keep-alive",
        },
    })
);

// ===================== UTIL I/O =====================
function ask(question, { silent = false } = {}) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        if (!silent) {
            rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); });
            return;
        }
        // Mask password dengan "*"
        const stdoutWrite = process.stdout.write;
        process.stdout.write = function (chunk, enc, cb) {
            if (typeof chunk === "string") {
                const masked = chunk.replace(/./g, "*");
                return stdoutWrite.call(process.stdout, masked, enc, cb);
            }
            return stdoutWrite.call(process.stdout, chunk, enc, cb);
        };
        rl.question(question, (ans) => {
            process.stdout.write = stdoutWrite;
            rl.output.write("\n");
            rl.close();
            resolve(ans.trim());
        });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) =>
    Math.min(150 * Math.pow(2, attempt), 2000) + Math.floor(Math.random() * 200);
const safePrint = (x) => String(typeof x === "string" ? x : JSON.stringify(x)).slice(0, 400);

// ===================== UTIL WAKTU (WIB) =====================
// Parse "YYYY-MM-DD HH:mm" atau "YYYY-MM-DD" ke epoch, anggap WIB (UTC+7)
function parseJakartaToEpoch(s) {
    if (!s) return null;
    const t = s.trim();
    const hasTime = t.includes(" ");
    const [d, h] = hasTime ? t.split(" ") : [t, "00:00"];
    const [Y, M, D] = d.split("-").map(Number);
    const [hh, mm] = h.split(":").map(Number);
    const epoch = Date.UTC(Y, M - 1, D, (hh || 0) - 7, mm || 0, 0, 0);
    return isNaN(epoch) ? null : epoch;
}
const nowEpoch = () => Date.now();
const fmtLocal = (epoch) => new Date(epoch).toISOString().replace("T", " ").replace("Z", " UTC");

// ===================== LOGIN FLOW =====================
let LAST_CSRF = null;

async function fetchCsrfTokenIfAny() {
    try {
        const res = await httpClient.get(LOGIN_PAGE, {
            headers: { "Referer": BASE + LOGIN_PAGE, "Origin": BASE },
        });
        if (res.status >= 200 && res.status < 400 && typeof res.data === "string") {
            const html = res.data;
            // hidden input _token (Laravel) atau meta csrf-token
            let m = html.match(/name=['"]_token['"][^>]*value=['"]([^'"]+)['"]/i);
            if (m) return m[1];
            m = html.match(/<meta[^>]+name=['"]csrf-token['"][^>]*content=['"]([^'"]+)['"]/i);
            if (m) return m[1];
        }
    } catch (_) {}
    return null; // jika tidak ada / tidak diperlukan
}

async function login(email, password) {
    const csrf = await fetchCsrfTokenIfAny();
    LAST_CSRF = csrf || null;

    // Coba form-urlencoded terlebih dahulu (paling umum untuk form login)
    const form = new URLSearchParams();
    form.set("email", email);
    form.set("password", password);
    if (csrf) form.set("_token", csrf);

    let res;
    try {
        res = await httpClient.post(
            LOGIN_ENDPOINT,
            form,
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": BASE,
                    "Referer": BASE + LOGIN_PAGE,
                },
            }
        );
    } catch (err) {
        // fallback: coba JSON
        res = await httpClient.post(
            LOGIN_ENDPOINT,
            { email, password, _token: csrf || undefined },
            {
                headers: {
                    "Content-Type": "application/json",
                    "Origin": BASE,
                    "Referer": BASE + LOGIN_PAGE,
                },
            }
        );
    }

    if (!(res.status >= 200 && res.status < 400)) {
        throw new Error(`Login gagal: HTTP ${res.status} ${safePrint(res.data)}`);
    }

    // Validasi ada cookie sesi
    const cookies = await jar.getCookies(BASE);
    const hasSession = cookies.some((c) => /session|sk_puis2|phpsessid/i.test(c.key));
    if (!hasSession) {
        console.warn("[WARN] Tidak menemukan cookie sesi eksplisit. Pastikan login memang sukses.");
    }
}

// ===================== AMBIL & PILIH EVENT =====================
async function fetchEvents() {
    // Get current year-month for the event_date parameter
    const now = new Date();
    const eventDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const payload = new URLSearchParams();
    payload.set("a", "list_all");
    payload.set("event_date", eventDate);

    const res = await httpClient.post(LIST_ENDPOINT, payload, {
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": BASE,
            "Referer": BASE + LIST_ENDPOINT,
        },
    });
    if (res.status !== 200)
        throw new Error(`Gagal ambil event: HTTP ${res.status} ${safePrint(res.data)}`);

    const list = res.data?.result;
    if (!Array.isArray(list))
        throw new Error(`Struktur respons tak terduga: ${safePrint(res.data)}`);
    return list;
}

async function waitForTargetEvent() {
    let attempt = 0;
    while (true) {
        attempt++;
        console.log(`\n[SEARCH #${attempt}] ${new Date().toLocaleString("id-ID")} - Mencari event PREUNI...`);
        try {
            const list = await fetchEvents();
            console.log(`Ditemukan ${list.length} event total:`);

            list.forEach((e) => {
                const isTarget = NAME_KEYWORDS.some((k) =>
                    String(e.event_name || "").toLowerCase().includes(k.toLowerCase())
                );
                const marker = isTarget ? "🎯 [TARGET]" : "  ";
                console.log(`${marker} [${e.id}] ${e.event_name} | start=${e.reservation_start_date} | sisa=${e.remaining_quota}`);
            });

            const targetEvents = list.filter((e) =>
                NAME_KEYWORDS.some((k) => String(e.event_name || "").toLowerCase().includes(k.toLowerCase()))
            );

            if (targetEvents.length > 0) {
                console.log(`\n✅ Event PREUNI ditemukan! (${targetEvents.length} event tersedia)`);
                return targetEvents[0];
            }

            console.log(`❌ Event PREUNI tidak tersedia saat ini. Coba lagi dalam 10 detik...`);
            await sleep(10000);
        } catch (err) {
            console.error(`[ERROR] ${err.message}. Retry dalam 20 detik...`);
            await sleep(20000);
        }
    }
}

function scoreEvent(e) {
    // Prioritas: keyword match -> reservation_start terdekat -> event_date terdekat
    let namePenalty = 0;
    if (NAME_KEYWORDS.length) {
        const name = String(e.event_name || "").toLowerCase();
        const hit = NAME_KEYWORDS.some((k) => name.includes(k.toLowerCase()));
        namePenalty = hit ? 0 : 1_000_000;
    }
    const now = nowEpoch();
    const startEpoch = parseJakartaToEpoch(e.reservation_start_date);
    const eventEpoch = parseJakartaToEpoch(e.event_date);
    const FUTURE_BUFFER_MS = 60 * 1000; // toleransi mundur 60 detik

    let timeScore;
    if (startEpoch) timeScore = Math.max(0, startEpoch - (now - FUTURE_BUFFER_MS));
    else if (eventEpoch) timeScore = Math.max(0, eventEpoch - now) + 10_000_000;
    else timeScore = 99_000_000;

    const quotaPenalty = Number(e.remaining_quota) > 0 ? 0 : 5_000;
    return namePenalty + timeScore + quotaPenalty;
}

function autoPickEvent(list) {
    if (!list.length) throw new Error("Tidak ada event.");
    const ranked = list.map((e) => ({ e, s: scoreEvent(e) })).sort((a, b) => a.s - b.s);
    return ranked[0].e;
}

// ===================== BOOKING =====================
let DETECTED_BOOK_ENDPOINT = null;

function ajaxHeaders(endpoint, isForm) {
    return {
        "Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Origin": BASE,
        "Referer": BASE + LIST_ENDPOINT,
    };
}

function looksSuccess(res) {
    const d = res?.data;
    if (d && typeof d === "object") {
        if (d.success === true || d.status === "ok") return true;
        if (d.message && /success|berhasil/i.test(String(d.message))) return true;
        // beberapa backend kembalikan {error:false}
        if (d.error === false) return true;
    }
    if (typeof d === "string" && /success|berhasil/i.test(d)) return true;
    return false;
}

async function detectBookingEndpoint(event) {
    if (DETECTED_BOOK_ENDPOINT) return DETECTED_BOOK_ENDPOINT;

    console.log("\n🔍 Mendeteksi endpoint booking yang benar...");
    for (const endpoint of POSSIBLE_BOOK_ENDPOINTS) {
        try {
            console.log(`   Mencoba: ${endpoint}`);
            const payloads = [
                // Paling mirip web:
                new URLSearchParams({ a: "enroll_event", id: String(event.id), ...(LAST_CSRF ? { _token: LAST_CSRF } : {}) }),
                // Variasi lain bila backend punya handler berbeda:
                new URLSearchParams({ a: "book", event_id: String(event.id), participant_type: "all", qty: "1", ...(LAST_CSRF ? { _token: LAST_CSRF } : {}) }),
                new URLSearchParams({ action: "register", event_id: String(event.id), qty: "1", ...(LAST_CSRF ? { _token: LAST_CSRF } : {}) }),
                new URLSearchParams({ event_id: String(event.id), participant_type: "all", qty: "1", ...(LAST_CSRF ? { _token: LAST_CSRF } : {}) }),
            ];

            for (let i = 0; i < payloads.length; i++) {
                const payload = payloads[i];
                console.log(`     Payload ${i + 1}: ${payload.toString()}`);

                const res = await httpClient.post(endpoint, payload, {
                    headers: ajaxHeaders(endpoint, true),
                });

                console.log(`     Status: ${res.status}`);
                console.log(`     Response: ${safePrint(res.data)}`);

                if (res.status === 200 && res.data) {
                    const response = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
                    if (
                        !response.includes("unknown AJAX route") &&
                        !response.includes("no handler for this route") &&
                        !response.includes("404")
                    ) {
                        console.log(`   ✅ Endpoint ditemukan: ${endpoint} dengan payload ${i + 1}`);
                        DETECTED_BOOK_ENDPOINT = endpoint;
                        return endpoint;
                    }
                }
            }

            console.log(`   ❌ ${endpoint} - semua payload gagal`);
        } catch (err) {
            console.log(`   ❌ ${endpoint} - error: ${err.message}`);
        }
    }

    console.log("   ⚠️  Menggunakan endpoint default (list endpoint)");
    DETECTED_BOOK_ENDPOINT = LIST_ENDPOINT;
    return LIST_ENDPOINT;
}

function buildPayloadForm(event) {
    // Meniru H.Post({ a:'enroll_event', id })
    const p = new URLSearchParams();
    p.set("a", "enroll_event");
    p.set("id", String(event.id));
    if (LAST_CSRF) p.set("_token", LAST_CSRF);
    return p;
}

function buildPayloadJSON(event) {
    return { a: "enroll_event", id: event.id, _token: LAST_CSRF || undefined };
}

async function bookingPath(event) {
    return await detectBookingEndpoint(event);
}

async function sendOneShot(event) {
    const endpoint = await bookingPath(event);
    const isForm = BOOK_PAYLOAD_MODE === "form";
    const payload = isForm ? buildPayloadForm(event) : buildPayloadJSON(event);
    const headers = ajaxHeaders(endpoint, isForm);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await httpClient.post(endpoint, payload, { headers });
            if (res.status >= 200 && res.status < 300) {
                if (looksSuccess(res)) {
                    console.log(`[OK] ${res.status}`, safePrint(res.data));
                    return true;
                }
                // fallback: terima 2xx sebagai "mungkin berhasil" (tergantung backend)
                console.log(`[OK?] ${res.status}`, safePrint(res.data));
                return true;
            }
            if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
                const w = backoff(attempt);
                console.warn(`[RETRY] HTTP ${res.status} attempt ${attempt + 1}/${MAX_RETRIES} tunggu ${w}ms`);
                await sleep(w);
                continue;
            }
            console.error(`[FAIL] HTTP ${res.status}`, safePrint(res.data));
            return false;
        } catch (err) {
            const w = backoff(attempt);
            console.warn(`[ERR] ${err.message} attempt ${attempt + 1}/${MAX_RETRIES} tunggu ${w}ms`);
            await sleep(w);
        }
    }
    return false;
}

async function fireBurst(event) {
    if (event.booking_id) {
        console.log("[INFO] Kamu sudah punya booking untuk event ini. Skip tembak.");
        return true;
    }
    console.log(`[FIRE] ${new Date().toISOString()} — kirim ${PARALLEL_SHOTS} request…`);
    // jitter kecil agar tidak semua request pada millisecond yang sama
    const tasks = Array.from({ length: PARALLEL_SHOTS }, async (_, i) => {
        await sleep(Math.floor(Math.random() * 25) + i);
        return sendOneShot(event);
    });
    const results = await Promise.allSettled(tasks);
    const ok = results.some((r) => r.status === "fulfilled" && r.value === true);
    console.log(ok ? "[RESULT] Ada yang berhasil." : "[RESULT] Belum ada yang sukses—cek payload/header.");
    return ok;
}

// ===================== WAIT SAMPAI MULAI =====================
async function waitUntilStart(event) {
    const startEpoch = parseJakartaToEpoch(event.reservation_start_date);
    if (!startEpoch) {
        console.log("[INFO] reservation_start_date tidak ada; langsung tembak.");
        return;
    }
    if (nowEpoch() >= startEpoch) {
        console.log(`[INFO] Window sudah mulai (start: ${fmtLocal(startEpoch)}), tembak segera.`);
        return;
    }
    const waitMs = startEpoch - nowEpoch();
    console.log(`[INFO] Menunggu hingga ${fmtLocal(startEpoch)} (~${Math.floor(waitMs / 1000)}s)`);
    const early = Math.max(0, waitMs - ARRIVE_EARLY_MS);
    await sleep(early);
    while (nowEpoch() < startEpoch) {
        const left = startEpoch - nowEpoch();
        await sleep(Math.min(MICRO_POLL_MS, Math.max(1, left)));
    }
}

// ===================== MAIN =====================
(async function main() {
    try {
        const email = await ask("Email: ");
        const password = await ask("Password: ", { silent: true });

        console.log("\n[LOGIN] Proses login…");
        await login(email, password);
        console.log("[LOGIN] Sukses (atau terautentikasi).");

        console.log("\n🔍 Mode polling: Mencari event PREUNI yang tersedia...");
        console.log("⏰ Bot akan terus mencari hingga menemukan event PREUNI");
        console.log("🎯 Target keyword:", NAME_KEYWORDS.join(", "));
        console.log("🤖 Setelah ditemukan, bot akan AUTO BOOKING secara otomatis!\n");

        const target = await waitForTargetEvent();

        console.log("\n[TARGET FOUND]");
        console.log(`ID                 : ${target.id}`);
        console.log(`Nama               : ${target.event_name}`);
        console.log(`Event date         : ${target.event_date}`);
        console.log(`Tempat             : ${target.place}`);
        console.log(`Kuota / sisa       : ${target.quota} / ${target.remaining_quota}`);
        console.log(`Reservasi          : ${target.reservation_start_date} — ${target.reservation_end_date}\n`);

        await waitUntilStart(target);
        await fireBurst(target);
    } catch (err) {
        console.error("[FATAL]", err?.message || err);
        process.exit(1);
    }
})();
