#!/usr/bin/env python3
"""
Finger Family — Gemini DIRECT Prompt Gen (Optimizer-dostu)
===========================================================
Yeni mimari: Claude katmanı YOK.
  Gemini videoyu İZLER (gerçek hareketi görür)
  + kullanıcı notunu NİYET/KARAKTER çapası alır
  → v1/v2/v3'ü DOĞRUDAN optimizer-dostu stilde yazar (tek sürekli hareket)
  → çıktı hailuo_prompts_claude.json formatında → Hailuo pipeline değişmeden okur
  → Hailuo'da useOriginPrompt: False (OPTIMIZER AÇIK) ile gönderilir

Neden işe yarıyor:
  Hailuo optimizer'ı videoyu GÖRMEZ, sadece metni+kareyi görür. Gemini gerçek
  hareketi görür. Gemini optimizer-stilinde yazınca, optimizer'a eksik olan tek
  şeyi (gerçek hareket/timing) vermiş oluyoruz → en temiz sonuç, en az morph.

KULLANIM:
  export GEMINI_API_KEY="..."
  python3 finger_family_gemini_direct.py            # SCENE_RANGE'e göre (varsayılan 1-8)

GEREKSİNİM: pip install --upgrade google-genai   (≥1.51)
"""

import os, json, time, sys, re, subprocess, shutil, base64, io
from pathlib import Path

try:
    from google import genai
    from google.genai import types
except ImportError:
    print("❌ google-genai gerekli: pip install google-genai"); sys.exit(1)

# ─── AYARLAR ──────────────────────────────────────────────────────
# Bu pipeline GENELDİR. Videoya özel her şey (yol, hikaye, karakterler, tema)
# çalışınca SORULUR. Aşağıdaki yol değerleri setup_project() içinde doldurulur.
PROJECT_NAME = None
BASE = VIDEO_PATH = SOURCE_JSON = OUTPUT_DIR = PROMPTS_JSON = OVERLAY_JSON = None
CONTEXT_FILE = CHAR_REFS_DIR = SWAP_FLAG_FILE = None
KEYFRAMES_SWAPPED_DIR = KEYFRAMES_ORIG_DIR = None
STORY_FILE = CHARS_FILE = THEME_FILE = None

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL   = "gemini-3.1-pro-preview"

SCENE_RANGE  = (1, 999)   # tüm sahneler (setup'ta sahne sayısına göre kırpılır)
SELF_CHECK   = True       # üretilen v1/v2/v3'ü ikinci bir Gemini geçişiyle denetle/düzelt

# Videoya özel, çalışınca SORULAN bilgiler:
VIDEO_STORY   = ""        # 1) konu / hikaye akışı
VIDEO_CHARS   = ""        # 2) karakterler + görünüm
VIDEO_THEME   = ""        # 3) tema / ton
VIDEO_CONTEXT = ""        # üçünün birleşimi (intro'ya gider)
CHAR_REFS     = []        # [(isim, b64), ...] face-swap referansları
SWAP_ON       = False     # face-swap aktif mi (ensure_chars doldurur)

STYLE_TAG    = "Vibrant colorful 3D cartoon, big expressive exaggerated faces, bright animation, smooth shading"
STYLE_TAG_FACE  = "Vibrant colorful 3D cartoon, big expressive exaggerated faces, bright animation, smooth shading"
STYLE_TAG_PLAIN = "Vibrant colorful 3D cartoon, bright animation, smooth shading"   # yüz görünmeyen sahneler
MAX_V1, MAX_V2, MAX_V3 = 460, 260, 520

def setup_project():
    """Proje yolunu sor, video/json/keyframes'i otomatik bul, path globallerini doldur."""
    global PROJECT_NAME, BASE, VIDEO_PATH, SOURCE_JSON, OUTPUT_DIR, PROMPTS_JSON, OVERLAY_JSON
    global CONTEXT_FILE, CHAR_REFS_DIR, SWAP_FLAG_FILE, KEYFRAMES_SWAPPED_DIR, KEYFRAMES_ORIG_DIR
    global STORY_FILE, CHARS_FILE, THEME_FILE
    # yol: --path argümanı, yoksa sor, yoksa içinde bulunulan klasör
    path = None
    if "--path" in sys.argv:
        i = sys.argv.index("--path")
        if i+1 < len(sys.argv): path = sys.argv[i+1]
    if not path:
        log("📂 Proje klasörünün TAM yolunu yapıştır (boş bırakırsan bulunduğun klasör):")
        try: path = input().strip()
        except EOFError: path = ""
    BASE = Path(path) if path else Path.cwd()
    if not BASE.exists():
        log(f"❌ Klasör yok: {BASE}"); sys.exit(1)
    PROJECT_NAME = BASE.name
    # video: ilk .mp4
    vids = sorted([p for p in BASE.iterdir() if p.suffix.lower()==".mp4"])
    if not vids: log(f"❌ {BASE} içinde .mp4 yok"); sys.exit(1)
    VIDEO_PATH = vids[0]
    # json: *_scenes_manual.json > *_scenes.json > ilk *scenes*.json
    js = list(BASE.glob("*_scenes_manual.json")) or list(BASE.glob("*_scenes.json")) or list(BASE.glob("*scenes*.json"))
    if not js: log(f"❌ {BASE} içinde *scenes*.json yok"); sys.exit(1)
    SOURCE_JSON = js[0]
    # keyframes klasörü: keyframes_swapped > keyframes
    KEYFRAMES_SWAPPED_DIR = (BASE/"keyframes_swapped") if (BASE/"keyframes_swapped").exists() else (BASE/"keyframes")
    KEYFRAMES_ORIG_DIR    = (BASE/"keyframes") if (BASE/"keyframes").exists() else KEYFRAMES_SWAPPED_DIR
    OUTPUT_DIR   = BASE / f"{PROJECT_NAME}_output"
    PROMPTS_JSON = OUTPUT_DIR / "hailuo_prompts_claude.json"
    OVERLAY_JSON = BASE / f"{PROJECT_NAME}_overlay_cues.json"
    CONTEXT_FILE = BASE / f"{PROJECT_NAME}_context.txt"   # (eski; artık 3 ayrı dosya)
    STORY_FILE   = BASE / f"{PROJECT_NAME}_story.txt"
    CHARS_FILE   = BASE / f"{PROJECT_NAME}_characters.txt"
    THEME_FILE   = BASE / f"{PROJECT_NAME}_theme.txt"
    CHAR_REFS_DIR  = BASE / "char_refs"
    SWAP_FLAG_FILE = BASE / f"{PROJECT_NAME}_swap.txt"
    log(f"📂 Proje: {PROJECT_NAME}")
    log(f"   🎬 video: {VIDEO_PATH.name}")
    log(f"   📄 json : {SOURCE_JSON.name}")
    log(f"   🖼  keyframes: {KEYFRAMES_SWAPPED_DIR.name}/")

# ─── KARAKTER NORMALİZASYONU (devre dışı — kimlik referanslarla yönetiliyor) ──
def normalize_char(text: str) -> str:
    return text



# ─── SYSTEM PROMPT (optimizer-dostu yazım tekniği gömülü) ─────────
SYSTEM_PROMPT = f"""You are a Hailuo I2V prompt engineer for a 3D children's cartoon.
You WATCH the actual video to see the real motion and timing, then write THREE prompt
variants (v1, v2, v3) directly, in Hailuo's PREFERRED cinematic style.

═══ CHARACTER RULE (ABSOLUTE) ═══
The CAST, STORY and TONE for THIS video are given in the CONTEXT block of the user message
(STORY / CHARACTERS / THEME) — read them and follow them. Identify each character by the role
described there and by the keyframe/video. If CHARACTER REFERENCE images are provided, each
character's true APPEARANCE (face, hair, color) comes from those references, NOT from the video.
Never invent characters that aren't in the video/keyframe. In every scene, give EVERY visible
character a movement (see MULTI-CHARACTER rule). Take motion/action from the video; take appearance
from the references (if any) or the keyframe.

═══ THE OPTIMIZER-FRIENDLY WRITING TECHNIQUE (use for ALL variants) ═══
The prompt optimizer is ON. It rewrites prompts into a cinematic single-action form.
Write in THAT form yourself so the optimizer only polishes, never fights you. Five rules:

1. SUBJECT ANCHOR FIRST: name who/what with a short visual descriptor
   ("The baby", "The toddler", "an adult hand") so identity stays stable.
2. ONE CONTINUOUS ACTION (most important — kills morphing):
   Collapse any "then… then… then" chain into ONE flowing motion.
   Use "gradually", "smoothly", "in one motion", "as". NEVER a sequence of 3+ beats.
   BAD: "runs, loses balance, stumbles, tumbles, lands, clutches knee" (6 beats → morph)
   GOOD: "tumbles forward onto the grass in one smooth motion, ending propped on one hand holding his knee"
3. CAMERA — HAILUO BRACKET SYNTAX AT THE VERY START: begin EACH prompt (v1/v2/v3) with a camera
   tag in SQUARE BRACKETS, comma-separated, MAX 3 moves, using ONLY these official Hailuo moves:
   [Truck left] [Truck right] [Pan left] [Pan right] [Push in] [Pull out] [Pedestal up]
   [Pedestal down] [Tilt up] [Tilt down] [Zoom in] [Zoom out] [Shake] [Tracking shot] [Static shot]
   Format: one opening bracket, moves separated by commas, then continue the sentence. Examples:
     "[Static shot] The cow gazes up at the balloon..."
     "[Pan right, Push in] The boy reaches for..."
     "[Truck left, Pan right, Tracking shot] The kite drifts across..."
   Pick moves that match the REAL camera motion in the video (mostly [Static shot] for these scenes).
   Do NOT write camera words in prose ("STATIC SHOT —", "slow pan right") — the bracket REPLACES them.
4. EFFECT LAYER — DIEGETIC ONLY (caused by the event, never generic atmosphere):
   Do NOT add generic "soft outdoor lighting", "warm glow", "ambient light".
   ONLY add an effect the EVENT itself produces, described as coming FROM the event. Examples:
     button pressed / coin dropped → "the machine's panel lights blink on and a sparkle bursts from the slot"
     screen / display → "the icons glow and flash across the display"
     reveal / magic → "a bright sparkle pops near the object as it appears"
     splash / water → "a small splash of water droplets sprays up"
     dust on fast exit → "a little puff of dust kicks up where he was"
     celebration → "a few confetti bits flutter down"
     impact (safe) → "a small puff bursts at the point of contact"
     glow-up → "the object gives a quick proud shine"
   If no event-driven effect fits, add NOTHING. A short STATIC setting noun is OK ("in the sunny garden",
   "inside the cozy tent") — but NO moving/changing light words.
5. STYLE/MOOD: v1 and v3 END with a style tag (the script appends it — do NOT write your own).

═══ HOW TO USE THE USER NOTE ═══
You get a Turkish user note = the creator's INTENT. Honor its SPECIFIC verbs
(iter=push, kapar=snatch, koşar=run, tökezler=stumble, diz=knee) and its character identity.
But take the REAL motion, timing and continuity from WATCHING the video.
Do NOT invent actions not in the note or the video.

═══ FRAME MODE ═══
both: you see start AND end — write the smooth TRANSITION between them, landing = end pose.
start_only: Hailuo animates 6s FORWARD — give a clear LANDING. Be creative but keep ONE motion.
end_only: Hailuo starts FROM this pose and continues — CONTINUE the visible action, never "settles/already done".

═══ LOOK AT THE KEYFRAME (provided per scene) ═══
For each scene you ALSO get the actual START frame image Hailuo will animate from. STUDY IT before writing.
Decide "face_visible": is a character's FACE clearly in shot?
  - If the frame shows only hands/objects/a machine, or the character is from BEHIND, or the face is
    out of frame → face_visible = false.
  - Then: do NOT write facial actions or face gags (no "jaw drops", "eyes widen", "blinks").
    Drive motion from what IS visible (hands, the object, the machine, body, camera).
    For v2 in an object/machine/screen scene, do NOT return "not applicable" — give a diegetic
    object-idle effect instead (see the V2 rule). "not applicable" is only for a character from behind.
  - If a face IS clearly visible → face_visible = true, facial micro-moves and face gags are allowed.
NEVER ask Hailuo to animate a face that is not in the frame — it will invent/morph a face. This is critical.
Output "face_visible": true/false per scene (the script picks the right style tag from it).

═══ EXPRESSION LIBRARY — turn one Turkish emotion word into a RICH physical description ═══
The user note often gives a single feeling ("mutlu", "üzgün", "şaşırdı"). A video tool cannot animate
an abstract word — it animates PHYSICAL muscle movement. So ALWAYS translate the emotion into a
concrete, visible facial/body description. Draw from this pool (these are options, not a fixed list —
invent more in the same spirit). ⚠️ VARY your choice across scenes: never reuse the same phrase twice
in a row (do NOT lean on "huge delighted grin" every time). Pick what fits the exact moment.

HAPPY / JOYFUL: beams a wide grin · grins ear to ear · cheeks lift as eyes crinkle · face lights up ·
  breaks into a delighted smile · bounces with glee · giggles, shoulders shaking · claps and wiggles ·
  eyes sparkle with joy · a gleeful open-mouthed laugh · rosy-cheeked happy squeal
SAD / HURT: lower lip pushes into a trembling pout · chin quivers · eyes well up and brim with tears ·
  face crumples · shoulders sink · gaze drops to the floor · sniffles, nose wrinkling · big watery
  eyes blinking slowly · mouth curves down in a wobbly frown · buries face for a second
SURPRISED / SHOCKED: eyes go huge · jaw drops open · head snaps back · eyebrows shoot up · freezes
  mid-motion · mouth forms a round "o" · a sharp little gasp · whole body gives a startled jolt ·
  double-takes, looking twice · hands fly up near the cheeks
ANGRY / FRUSTRATED: brows knit hard and low · cheeks puff out · lips press into a tight line · nostrils
  flare · a stiff scowl · jaw clenches · arms cross with a huff · stamps with a grumpy frown ·
  shoulders hunch forward, glaring
DISGUSTED: scrunches the whole face · nose wrinkles tightly · tongue pokes out with a "bleh" · recoils
  with a grimace · squints and turns the head away · lips curl back · gives a queasy shudder
SCARED / NERVOUS: eyes dart side to side · shrinks back · shoulders pull up to the ears · lips tremble ·
  clutches something tightly · a tiny flinch · gulps, eyes wide · freezes then peeks
CURIOUS / THOUGHTFUL: tilts the head slowly · taps a finger on the chin · narrows eyes in focus ·
  leans in to inspect · eyebrows raise with interest · purses lips, pondering · slow blink of wonder
PROUD / CONFIDENT: lifts the chin high · puffs the chest · a smug little smile · hands on hips ·
  beams and gives a tiny satisfied nod · stands tall, beaming
SHY / EMBARRASSED: cheeks flush, glancing away · shoulders curl in · a small bashful smile · peeks up
  through lashes · fidgets with both hands · ducks the head with a tiny grin
EXCITED / EAGER: bounces in place · eyes wide and shining · leans forward eagerly · hands flap with
  excitement · a big anticipatory grin · practically vibrating with energy · reaches greedily
SLEEPY / TIRED: eyelids droop heavy · a wide yawn · head nods and bobs · rubs the eyes with little
  fists · slow, sluggish blinks · slumps softly

VERB RICHNESS — replace plain verbs with vivid, specific ones (vary across scenes):
  push → pushes / shoves / nudges / bumps / rams gently     take/grab → grabs / snatches / plucks / scoops / clutches
  fall → tumbles / topples / flops / crumples / keels over  drop → tips over / wobbles and falls / clatters down
  put in mouth → pops in / brings to the mouth / nibbles / chomps / gnaws    look → glances / peers / stares / eyes / studies
  run → dashes / scampers / bolts / toddles quickly         hold → grips / cradles / clutches / hugs to the chest
  turn → spins / swivels / twists around / pivots           give → offers / holds out / hands over / passes
  hit/knock → bumps / taps / knocks / topples (never "slams/smashes")   chew → munches / chomps / gnaws / nibbles
  reach → stretches toward / extends a hand / leans for     throw → tosses / lobs / flings gently

USE THESE to enrich V1, V2 and V3. The emotion word in the note is your CUE; the physical description
is what you WRITE. Match intensity to the variant: V1 natural, V2 strong-but-safe face, V3 a full gag.

═══ THE THREE VARIANTS ═══
v1 — CLEAN ACTION: the main action in optimizer style. Starts with the camera BRACKET, then ONE continuous motion + atmosphere + style tag. ≤{MAX_V1} chars.
v2 — SLOW-MOTION MAIN ACTION (low-morph, but ALIVE): SAME camera bracket as v1 (do NOT force push-in).
   ⚠️ V2 is NOT a frozen face shot. The character STILL PERFORMS the scene's main action — just SLOWLY,
   softly, in ONE gentle continuous motion. Low-morph comes from SLOWNESS, not from stillness.
   So: keep the same core action as v1, but in calm slow-motion (e.g. the boy slowly pushes the toys
   off the table), PLUS a strongly EXPRESSIVE face, PLUS one blink, PLUS one symbol if it fits.
   The event must actually HAPPEN in V2 (don't drop the action and let things move by themselves).
   ✅ SAFE FACE EXAGGERATION (intensity of real features): "wide-open mouth in shock", "eyes go huge",
      "brows knit hard, lips pressed", "beams a huge grin", "lower lip in a big trembling pout".
   ❌ NOT ALLOWED (morph/identity break): skin/face turning a colour, eyes leaving sockets, jaw detaching,
      head swelling, cheeks ballooning, FAST or chained motion. Intensity & slow action YES, transformation NO.
   Include: the slow main action + that expressive face + at least ONE blink + gentle breath.
   V2 SYMBOLS (V2 is the SAFE home for in-frame symbols):
     you MAY add ONE small symbol tied to the emotion/event:
       sleep → a small "Zzz" drifting above the head
       shout/yell → faint sound-wave arcs from the open mouth
       hit/surprise → a single small "POW"/"!" near the head
       music → one music note   |   love → one heart   |   idea → one sparkle/light-bulb
       stress → one sweat drop   |   thinking → a thought bubble (see fx_bubble)
     ONE only, in empty space. If none fits, omit.
   NO style tag. ≤{MAX_V2} chars.
   ⚠️ "not applicable" is ONLY for a character seen from BEHIND. If the scene has NO character but has
   OBJECTS/A MACHINE/A SCREEN (face_visible=false, object scene), do NOT write "not applicable" —
   instead make V2 a LIVELY OBJECT-IDLE shot driven by a DIEGETIC effect (the event's own result):
     machine/buttons → "the panel lights blink and pulse gently, a small sparkle flickering at the slot"
     object/toy → "a small sparkle pops as the object lights up briefly"
     reveal/open → "a little sparkle bursts as the box/lid opens"
   Keep it small, looping, no morph. This makes object scenes still have a usable, eye-catching V2.
v3 — CARTOON GAG: v1's action PLUS one child-friendly acting gag woven in (a GESTURE, never a symbol —
   symbols live in V2): double_take, eye_pop, jaw_drop, pout, sneaky grin, happy clap, head
   bobble, victory wiggle, stomp, proud chin-up, peek-a-boo. Keep it ONE continuous motion. + style tag. ≤{MAX_V3} chars.

═══ MULTI-CHARACTER — NO FROZEN CHARACTERS (HIGH PRIORITY, overrides length limits) ═══
Look at the keyframe/video and COUNT every visible character. EVERY visible character MUST have at
least one verb/movement in v1 AND v3 (and a facial beat in v2 if their face shows). No one stands frozen.
⚠️ The user note often describes ONLY the main character. For every OTHER visible character that the
note does NOT mention, YOU add a small reaction/gesture that fits the video flow and the scene's mood:
  a glance, a lean-in, a worried frown, a step back, a giggle, a head turn, ears perking, a small hop.
Connect ALL simultaneous characters with "while"/"as"/"meanwhile" — never separate sentences.
  BAD: "The main character does X." (other visible characters left frozen)
  GOOD: "Character A does X while character B reacts (a glance/lean/step) and character C
         turns toward them." (every visible character gets a movement)
MORPH BALANCE: give background/extra characters SMALL, safe moves only (glance, lean, step, blink,
small hop) — not big body actions — so the frame stays alive WITHOUT crowding into morph. The main
character keeps the primary action; others support it subtly.

═══ IN-FRAME SYMBOL & GAG — PROACTIVE (you decide, even if the note is silent) ═══
You WATCH the video, so you judge each scene's emotion/event. Add expressive touches PROACTIVELY
but with RESTRAINT — only when they genuinely strengthen the moment, never to fill every scene.

fx_inframe — note-based symbols only (woven into v1/v3 ONLY if the USER NOTE explicitly names a symbol):
  - If the note says a symbol (ter damlası, kalp, parıltı), you may keep ONE in v1/v3, subtle, in empty
    space, never on the body. If the note is silent, do NOT add symbols to v1/v3 — keep them clean.
  - ALL proactive/emotion-based symbols (Zzz, POW, sound waves, heart, sparkle, sweat, music note,
    light-bulb, etc.) belong in V2 ONLY (see the V2 SYMBOLS rule above) — V2 is the safe home because
    its body is still. Do NOT scatter symbols into v1/v3.
  - These remain POST overlays → fx_overlay, NEVER in any prompt text:
      question/anger marks as screen graphics, spinning dizzy stars, storm cloud, impact star burst,
      screen shake, alarm flash, iris, countdown, motion trail.

GAG — CARTOON ACTING BEAT (woven into v3; a gesture the character performs, never a symbol):
  Pick ONE fitting the emotion and BLEND it into the single continuous action:
    surprise/shock → eye-pop, jaw-drop, double-take, head-snap-back, big gulp, freeze-then-react
    mischief/sneaky (baby) → sneaky grin, glance around, sly look before grabbing a toy
    sad/hurt → trembling pout, lip quiver, shoulder slump, sniffle, hug knees, wipe a tear
    angry → foot stomp, arms-crossed huff, furrowed glare, cheek puff, fists clench
    joy/play → happy clap, head bobble, victory wiggle, proud chin-up, bounce, kick feet, giggle
    confusion → slow head tilt, scratch head, blink-blink, look around puzzled
    affection → shy smile, cheek blush, lean-in nuzzle
    teasing → tongue out, nose scrunch, playful wink (4th-wall)
    timing beats → anticipation pause (wait… then react), delayed reaction / slow burn
  SAFE EXAGGERATION (Tom&Jerry energy WITHOUT morph): head snaps back, eyes go wide, body bounces/
    recoils, springs back, big take. NEVER literal squash/stretch (no "head swells", "body flattens",
    "eyes pop out of sockets", "accordion" — Hailuo morphs these; route impact-stars/bump to fx_overlay).
  MORPH SAFETY by frame_mode:
    start_only / end_only (drift risk) → LOW-MORPH FACE/TIMING gag (eye-pop, jaw-drop, slow blink,
      double-take, anticipation pause). Avoid big body gags.
    both (interpolation guides motion) → body gags fine (clap, bobble, wiggle, stomp, bounce).
  Keep it ONE flowing motion; never turn v3 into a then→then chain.

fx_bubble — THOUGHT/SPEECH BUBBLE (V2 ONLY; Hailuo can render a simple static bubble):
  - If the character clearly imagines/wants/thinks/feels something, you MAY add ONE static bubble in an
    empty corner in v2: "a small [thought|speech] bubble already floating beside the head, showing a
    single [image]". It floats gently — NEVER animate or morph its inside, ONE only.
  - PICK the [image] from this CHILD-FRIENDLY POOL to fit the scene's mood (be creative, vary it):
      WANT/CRAVE → a toy, a treat, an object the character wants, a heart toward someone
      LOVE/HAPPY → a heart, hearts, a smiling face, a sun, a star, a rainbow, balloons
      SAD/HURT (kept cute, NOT graphic) → big cartoony teardrops, a sad blue face, a band-aid/plaster,
        an ice pack, a toy doctor kit, a hug/heart-with-arms, a "get well" heart
      CONFUSED → a question mark, a swirl, a tilted head doodle
      ANGRY → a little storm cloud, a puffing red face doodle, crossed arms doodle
      SLEEPY → "Zzz", a pillow, a crescent moon
      IDEA → a light bulb, a sparkle
      FOOD/YUM → a plate, the treat, sparkly eyes doodle
      SCARED → wide-eyed face doodle, a small ghost/shadow doodle (gentle, cartoonish)
  - ⚠️ NEVER show injury/medical-graphic content: NO broken bones, X-ray of a bone, blood, wounds,
    bruises, or anything that depicts real harm. Keep it cartoon-cute and age-appropriate.
  - The image should relate to what the character feels/wants in THIS scene (don't invent unrelated objects).
    Otherwise omit.

fx_overlay — POST-PRODUCTION CUES (Hailuo CANNOT render these; output as a cue, never in prompt text):
  Choose when the moment calls for a non-diegetic screen effect. Output {{"type":"...","at":seconds}}:
    impact_star / impact_flash (a hit lands)      speed_lines (fast move/run)
    action_lines (focus/intensity)                screen_shake (big impact)
    dizzy_stars / spiral_eyes (dazed)             question_mark / exclamation (confusion/alert)
    anger_mark (rage)                             storm_cloud (gloom/fury)
    onomatopoeia_text ("POW","BOOM","SPLASH")     iris_in / iris_out (scene open/close)
    red_alarm_flash / vignette_pulse (danger)     countdown (tension)
    sticker_pop / emoji_pop (cute beat)           motion_trail (swish)
    confetti / sparkle_burst (celebration)        bump_lump (head bump after hit)
  At most ONE per scene, only if it clearly strengthens the beat; else "none".

═══ IN-FRAME SYMBOL (note-based) ═══
If the note mentions a SCREEN-overlay symbol, route it to fx_overlay, not the prompt text.

═══ AVOID (even with optimizer on) ═══
Aggressive verbs (slams, explodes, rockets), object morph/transform/melt, 3+ action chains,
pupils-to-pinpoints, jaw-unhinge. Keep motion gentle and continuous.
⚠️ NO ANIMATED LIGHTING in any variant: forbidden phrases include "soft light shifts",
"light settles/spreads", "sunlight glints/streams", "warm glow", "shimmer", "gleam",
"lens flare", "flickering light", "rays of light". Lighting stays constant — never describe it moving.

═══ OUTPUT ═══
Return ONLY a JSON array, one object per scene, no markdown:
[{{"scene_index": 1, "v1": "...", "v2": "...", "v3": "...", "emotion": "...", "face_visible": true, "fx_overlay": "none"}}]
fx_overlay: if the note mentions a SCREEN overlay symbol (question/anger/storm), put
{{"type":"...","at":seconds}} so it goes to POST; otherwise "none".
"""

# ─── YARDIMCILAR ──────────────────────────────────────────────────
def log(m): print(m, flush=True)

def load_scenes(path: Path):
    raw = json.loads(path.read_text())
    return raw["scenes"] if isinstance(raw, dict) and "scenes" in raw else raw

def compress_video(src: Path) -> Path:
    comp = src.with_stem(src.stem + "_small")
    if comp.exists(): return comp
    if not shutil.which("ffmpeg"): return src
    log(f"🎬 Video küçültülüyor → 720p...")
    cmd = ["ffmpeg","-i",str(src),"-vf","scale=-2:720","-c:v","libx264","-crf","28",
           "-preset","fast","-an","-y",str(comp)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        return comp if r.returncode == 0 else src
    except Exception:
        return src

def upload_or_cache(client) -> object:
    cache = BASE / f"{PROJECT_NAME}_gemini_file_cache.json"
    if cache.exists():
        try:
            c = json.loads(cache.read_text())
            chk = client.files.get(name=c.get("name",""))
            if chk.state.name == "ACTIVE":
                log(f"📦 Cache geçerli — yeniden yükleme yok"); return chk
        except Exception: pass
    up = compress_video(VIDEO_PATH)
    log(f"📤 Yükleniyor: {up.name} ({up.stat().st_size/1e6:.1f} MB)...")
    f = client.files.upload(file=up)
    while True:
        chk = client.files.get(name=f.name)
        if chk.state.name == "ACTIVE": break
        if chk.state.name == "FAILED": raise RuntimeError("upload FAILED")
        time.sleep(5)
    cache.write_text(json.dumps({"name": f.name, "uri": f.uri, "mime_type": f.mime_type}))
    log("   ✅ Video hazır"); return chk

def parse_json(text: str):
    if not text:
        return None
    text = text.strip()
    if text.startswith("```"): text = text.split("\n",1)[-1]
    if text.endswith("```"): text = text.rsplit("```",1)[0]
    try: return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r'\[.*\]', text, re.DOTALL)
        return json.loads(m.group()) if m else None

def fmt(s): 
    m,sec = divmod(s,60); return f"{int(m):02d}:{sec:05.2f}"

def _find_frame_in(d, label, frame_type):
    if d is None: return None
    for ext in (".jpg", ".png"):
        p = d / label / f"frame_{frame_type}{ext}"
        if p.exists(): return p
    return None

def find_frame(label, frame_type):
    """keyframes_swapped/<label>/frame_<type>.(jpg|png) → orijinal fallback"""
    return _find_frame_in(KEYFRAMES_SWAPPED_DIR, label, frame_type) or \
           _find_frame_in(KEYFRAMES_ORIG_DIR, label, frame_type)

def find_frame_pair(label, frame_type):
    """(swaplı kare, orijinal kare) döndürür.
    Orijinal sadece swap aktifken, ayrı bir klasörden geliyorsa ve swaplıdan
    farklı bir dosyaysa döner — aksi halde None (tek kare gönderilir)."""
    fp_swap = find_frame(label, frame_type)
    fp_orig = None
    if SWAP_ON and KEYFRAMES_ORIG_DIR != KEYFRAMES_SWAPPED_DIR:
        cand = _find_frame_in(KEYFRAMES_ORIG_DIR, label, frame_type)
        if cand and cand != fp_swap:
            fp_orig = cand
    return fp_swap, fp_orig

def encode_image(path):
    try:
        from PIL import Image
        img = Image.open(path).convert("RGB")
        w,h = img.size; r = min(1024/max(w,h), 1.0)
        if r < 1: img = img.resize((int(w*r), int(h*r)), Image.LANCZOS)
        buf = io.BytesIO(); img.save(buf, format="JPEG", quality=85)
        return base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        log(f"   ⚠️ keyframe okunamadı ({path}): {e}"); return None

def clip(text, mx, is_v1_v3, face_visible=True):
    if not text: return text
    if "not applicable" in text.lower():
        return text
    # Gemini'nin kendi yazdığı stil/ışık ifadelerini temizle
    text = re.sub(r'\s*3[dD]\s+(children\'?s|animated)?\s*cartoon style\.?', '', text)
    text = re.sub(r',?\s*(soft|warm|bright)?\s*(outdoor|ambient)?\s*lighting[^.,]*', '', text, flags=re.I)
    text = re.sub(r'\b(Vibrant colorful 3D cartoon[^.]*smooth shading)', '', text)  # tag tekrarını temizle
    # sızan komut parametrelerini temizle (--v 1.5, --t 4, --ar 16:9 ...)
    text = re.sub(r'\s*--[a-zA-Z]+\s+[0-9:\.]+', '', text)
    # köşeli parantez içi stil placeholder'ları temizle ([STYLE TAG], [STYLE: ...])
    text = re.sub(r'\s*\[\s*STYLE[^\]]*\]', '', text, flags=re.I)
    text = text.replace(" ,", ",").replace("  ", " ").strip().rstrip(",").strip()
    if is_v1_v3:
        tag = STYLE_TAG_FACE if face_visible else STYLE_TAG_PLAIN
        text = text + " " + tag
    return text

# ─── BATCH ────────────────────────────────────────────────────────
def _build_parts(vid, scenes, with_images, soften=False):
    parts = [types.Part.from_uri(file_uri=vid.uri, mime_type=vid.mime_type)]
    intro = (
        "VIDEO CONTEXT (what this whole video is about — use it to judge each scene's role, tone and "
        "which character is which):\n" + (VIDEO_CONTEXT.strip() or "(no context provided)") + "\n\n"
        "Watch these scenes and write v1/v2/v3 for each, in the optimizer-friendly single-action "
        "cinematic style. Honor each user note's intent and specific verbs, take the real motion from "
        "the video. Use the context above to get the EMOTION and STORY ROLE of each scene right "
        "(e.g. a tense beat should read as tension, a warm beat as warmth, per the THEME). ")
    if soften:
        intro += ("\nIMPORTANT: This is a wholesome, age-appropriate children's cartoon (like CoComelon). "
                  "Any 'anger/crying/scolding' is GENTLE, cartoonish and mild — a toddler pouts, frowns, "
                  "or sheds a cartoon tear; a parent gently gestures. Describe these emotions softly and "
                  "positively (a small pout, a gentle frown, a soft sniffle), never harshly. Keep it "
                  "light and friendly.\n")
    if with_images:
        intro += ("For EACH scene the actual START frame image is attached right after its note — "
                  "STUDY it and set face_visible, never animate a face that isn't in the frame, and "
                  "use only event-driven (diegetic) effects, never generic lighting.\n")
        if SWAP_ON:
            intro += ("Some scenes also include the ORIGINAL (pre-swap) frame for identity mapping only. "
                      "Appearance ALWAYS comes from the START frame + character references — never from "
                      "the original frame or the video.\n")
    else:
        intro += ("Judge face_visible from the video itself (is a face clearly in shot for that scene). "
                  "Use only event-driven (diegetic) effects, never generic lighting.\n")
    parts.append(types.Part.from_text(text=intro))
    if CHAR_REFS:
        parts.append(types.Part.from_text(text=(
            "\n=== CHARACTER REFERENCES (the TRUE current look of each character) ===\n"
            "The video may show the characters with an OLD/different face or hair. These reference "
            "images are their REAL, current appearance after a face-swap. ALWAYS take each character's "
            "APPEARANCE (face, hair, hair color, style) from these references — NEVER from the video. "
            "Take only the MOTION/action from the video. When you name a character, match it to the "
            "reference by name. Do not describe the old video look (e.g. don't say 'bald' if the "
            "reference shows curly hair).")))
        for name, b64 in CHAR_REFS:
            parts.append(types.Part.from_text(text=f'\nReference — "{name}" (this is what {name} truly looks like):'))
            parts.append(types.Part.from_bytes(data=base64.b64decode(b64), mime_type="image/jpeg"))
        parts.append(types.Part.from_text(text="\n=== END REFERENCES ===\n"))
    for s in scenes:
        note = normalize_char((s.get("scene_description") or "").strip())
        fs, ls = s.get("frame_first_seek"), s.get("frame_last_seek")
        st = fs if fs is not None else (ls or 0)
        en = ls if ls is not None else (fs or 0)
        fm = s.get("frame_mode","both")
        label = s.get("label", f"scene_{s['index']:03d}")
        ftype = "last" if fm == "end_only" else "first"
        note_line = note
        if soften:
            note_line += "  (render this emotion in a gentle, child-friendly, cartoonish way)"
        parts.append(types.Part.from_text(text=
            f'\nSCENE {s["index"]:03d} [{fmt(st)}→{fmt(en)}] [frame_mode: {fm}]\n  user note (intent): "{note_line}"'))
        if with_images:
            fp_swap, fp_orig = find_frame_pair(label, ftype)
            b64 = encode_image(fp_swap) if fp_swap else None
            if b64:
                if fp_orig:
                    parts.append(types.Part.from_text(text=
                        "  START frame for this scene — the EXACT image Hailuo will animate. "
                        "The characters' TRUE look (face/hair/color) is THIS. Describe THIS look:"))
                else:
                    parts.append(types.Part.from_text(text="  START frame for this scene:"))
                parts.append(types.Part.from_bytes(data=base64.b64decode(b64), mime_type="image/jpeg"))
            if fp_orig:
                b64o = encode_image(fp_orig)
                if b64o:
                    parts.append(types.Part.from_text(text=
                        "  Same moment from the ORIGINAL video (OLD look, before face-swap). Use it ONLY to "
                        "map which character is which between the video and the START frame above. NEVER "
                        "describe this old appearance (hair/face/color) in any prompt:"))
                    parts.append(types.Part.from_bytes(data=base64.b64decode(b64o), mime_type="image/jpeg"))
    parts.append(types.Part.from_text(text="\nReturn ONLY the JSON array."))
    return parts

def gen_batch(client, vid, scenes):
    SAFETY = [
        types.SafetySetting(category="HARM_CATEGORY_HARASSMENT",        threshold="BLOCK_NONE"),
        types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH",       threshold="BLOCK_NONE"),
        types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold="BLOCK_NONE"),
        types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_NONE"),
    ]
    last_err = None
    # tur zinciri: 1) görselli  2) GÖRSELSİZ  3) GÖRSELSİZ+SOFTEN (PROHIBITED kurtarma)
    for with_images, soften in ((True, False), (False, False), (False, True)):
        if soften: mode = "GÖRSELSİZ+YUMUŞAK (kurtarma)"
        elif with_images: mode = "görselli"
        else: mode = "GÖRSELSİZ (fallback)"
        for attempt in range(2):
            try:
                resp = client.models.generate_content(
                    model=GEMINI_MODEL,
                    contents=[types.Content(role="user", parts=_build_parts(vid, scenes, with_images, soften))],
                    config=types.GenerateContentConfig(
                        system_instruction=SYSTEM_PROMPT, temperature=0.4, max_output_tokens=20000,
                        safety_settings=SAFETY,
                        thinking_config=types.ThinkingConfig(thinking_level="low")))
                raw = resp.text
                if not raw:
                    pf = ""
                    try: pf = str(resp.prompt_feedback)
                    except Exception: pass
                    blocked = "PROHIBITED" in pf or "BLOCK" in pf
                    log(f"   ⚠️ boş yanıt ({mode}, {attempt+1}/2) feedback={pf}")
                    if blocked:
                        if with_images:
                            log("   ↪️ görsel bloğu — GÖRSELSİZ moda geçiliyor"); break
                        if not soften:
                            log("   ↪️ metin bloğu — YUMUŞAK kurtarma moduna geçiliyor"); break
                    time.sleep(5); continue
                parsed = parse_json(raw)
                if parsed:
                    if soften: log("   ✓ yumuşak kurtarma başarılı")
                    elif not with_images: log("   ✓ görselsiz fallback başarılı")
                    return parsed
                log(f"   ⚠️ JSON parse olmadı ({mode}, {attempt+1}/2)")
                time.sleep(5)
            except Exception as e:
                last_err = e
                log(f"   ⚠️ {mode} deneme {attempt+1}/2 hata: {e}")
                time.sleep(5)
    if last_err: raise last_err
    return None

SELF_CHECK_INSTRUCTION = """You are a Hailuo I2V prompt REVIEWER for a 3D children's cartoon. The cast/story/tone are defined by the project CONTEXT; give EVERY visible character a movement and keep each character's identity consistent.
You receive v1/v2/v3 for one scene plus its frame_mode, face_visible, the scene's user note (intent),
and (if available) the CHARACTERS block describing each character's TRUE current appearance.
CHECK and FIX violations.
Return ONLY corrected JSON: {"v1":"...","v2":"...","v3":"...","face_visible":true/false}. If all good, return unchanged.

RULES TO ENFORCE:
1. NO FROZEN CHARACTERS (highest priority): every character implied as visible (by the note or the prompts)
   must have a verb in v1 & v3. If one is frozen, add a small fitting reaction (glance/lean/step/giggle).
   Join simultaneous chars with "while"/"as".
2. MORPH SAFETY: remove literal squash/stretch/transform/melt, "head swells", "body flattens",
   "eyes pop out of sockets", skin/face turning a colour. Keep intensity via natural muscles only.
3. NO ANIMATED LIGHTING: delete "soft/warm/outdoor lighting", "light shifts/glows/flickers", "sunlight", "shimmer", "lens flare".
4. SINGLE CONTINUOUS ACTION: collapse any then→then→then chain into one flowing motion.
5. V2 = SLOW main action (NOT frozen): same camera as v1; the character DOES perform the scene's main
   action but slowly/gently in one motion (don't drop it); expressive FACE; one blink; ONE symbol max
   (Zzz/POW/sound waves/heart/sweat/!/bubble) if it fits; NO style tag. For object/machine scenes V2 must be a
   diegetic object-idle (lights pulse / icons glow / sparkle) — NOT "not applicable" (that's only for a character from behind).
6. V3 = v1 action + ONE acting gag (gesture, not a symbol). v1 = clean. Keep the camera BRACKET at the very start of v1/v2/v3 (e.g. "[Pan right, Push in]"); convert any prose camera ("STATIC SHOT —") into the bracket form.
7. face_visible=false → no facial actions/gags; no "exaggerated faces"; drive motion from hands/objects/body.
8. Screen overlays (impact stars, screen shake, alarm, iris, "POW" as screen graphic, dizzy spinning stars) must NOT be
   in the prompt text (they are post). In-frame single symbols in V2 are fine.
9. Keep style tag only on v1/v3 (the pipeline manages it); never on v2.
10. EXPRESSION RICHNESS: if an emotion is described with a flat/abstract word ("happy", "sad") or a
   repeated stock phrase ("huge delighted grin"), rewrite it as a concrete, varied PHYSICAL description
   (e.g. "cheeks lift as eyes crinkle", "lower lip trembles into a pout"). Don't reuse the same
   expression across v1/v2/v3 of one scene — vary them.
11. APPEARANCE CONSISTENCY (face-swap leak guard): if a CHARACTERS block is provided, every appearance
   detail in the prompts (hair, hair color, face, skin, clothing color) MUST match it. Delete or fix any
   description of an OLD/different look (e.g. "bald" when CHARACTERS says curly orange hair). When in
   doubt, drop the appearance adjective entirely and keep just the role noun ("the baby") — Hailuo sees
   the start frame, so a missing adjective is safer than a wrong one."""

def self_check(client, entry, face_vis):
    fm = entry.get("frame_mode","both")
    ctx = ""
    if VIDEO_CHARS:
        ctx += f'CHARACTERS (TRUE current appearance — prompts must match this look):\n{VIDEO_CHARS.strip()[:800]}\n\n'
    note = (entry.get("scene_desc") or "").strip()
    if note:
        ctx += f'Scene user note (intent — lists who is in the scene): "{note[:300]}"\n\n'
    inp = (ctx +
           f'frame_mode: {fm}\nface_visible: {face_vis}\n\n'
           f'v1: {entry.get("v1","")}\nv2: {entry.get("v2","")}\nv3: {entry.get("v3","")}\n\n'
           'Check against the rules and return ONLY the corrected JSON.')
    try:
        resp = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[types.Content(role="user", parts=[types.Part.from_text(text=inp)])],
            config=types.GenerateContentConfig(
                system_instruction=SELF_CHECK_INSTRUCTION, temperature=0.2, max_output_tokens=4000,
                thinking_config=types.ThinkingConfig(thinking_level="low")))
        raw = resp.text
        if not raw: return entry, []
        fixed = json.loads(re.search(r'\{.*\}', raw, re.DOTALL).group())
        changed = [k for k in ("v1","v2","v3") if k in fixed and fixed[k] != entry.get(k)]
        for k in ("v1","v2","v3"):
            if k in fixed: entry[k] = fixed[k]
        if "face_visible" in fixed:
            fv = fixed["face_visible"]
            entry["face_visible"] = fv if isinstance(fv, bool) else str(fv).lower() not in ("false","no","0")
        return entry, changed
    except Exception as e:
        log(f"   ⚠️ self-check atlandı: {e}")
        return entry, []

# ─── ANA ──────────────────────────────────────────────────────────
def _read_multiline():
    lines = []
    try:
        while True:
            line = input()
            if line.strip() == "" and lines: break
            if line.strip() == "" and not lines: continue
            lines.append(line)
    except EOFError:
        pass
    return "\n".join(lines).strip()

def _ask_field(title, file_path, example):
    """Bir alanı al: dosya varsa oku, yoksa/--ctx ise sor + kaydet."""
    force = "--ctx" in sys.argv
    if file_path.exists() and not force:
        val = file_path.read_text(encoding="utf-8").strip()
        log(f"📖 {title}: okundu ({len(val)} karakter)")
        return val
    log("\n" + "="*60)
    log(f"📝 {title}")
    log(f"   {example}")
    log("   (Bitince boş satır + ENTER)")
    log("="*60)
    val = _read_multiline()
    if val:
        file_path.write_text(val, encoding="utf-8")
        log(f"✅ kaydedildi → {file_path.name}")
    return val

def ensure_context():
    """Videoya özel 3 alanı al: hikaye, karakterler+görünüm, tema/ton."""
    global VIDEO_STORY, VIDEO_CHARS, VIDEO_THEME, VIDEO_CONTEXT
    if "--ctx" in sys.argv:
        log("\n🔄 Video bilgileri yeniden soruluyor (--ctx)")
    VIDEO_STORY = _ask_field(
        "1/3 — KONU / HİKAYE AKIŞI: Bu video ne anlatıyor? Olaylar sırasıyla.",
        STORY_FILE,
        "Örn: 'Kardeşler arası kıskançlık. Abi annenin bebekle ilgilenmesini kıskanır, oyunu bozar, küsüp çadıra gider, aile barıştırır.'")
    VIDEO_CHARS = _ask_field(
        "2/3 — KARAKTERLER + GÖRÜNÜM: Kim kim, nasıl görünüyor (rol + görünüm).",
        CHARS_FILE,
        "Örn: 'Abi: ~5 yaş erkek çocuk, kahverengi düz saç. Bebek: ~1 yaş, turuncu kıvırcık saç. Anne: uzun boylu, koyu saç...'")
    VIDEO_THEME = _ask_field(
        "3/3 — TEMA / TON: Genel his ve mesaj.",
        THEME_FILE,
        "Örn: 'Esprili, sıcak, öğretici; çocuk-dostu; kıskançlığın paylaşmayla çözülmesi.'")
    parts = []
    if VIDEO_STORY: parts.append("STORY (event flow):\n" + VIDEO_STORY)
    if VIDEO_CHARS: parts.append("CHARACTERS (role + appearance):\n" + VIDEO_CHARS)
    if VIDEO_THEME: parts.append("THEME / TONE:\n" + VIDEO_THEME)
    VIDEO_CONTEXT = "\n\n".join(parts)
    if not VIDEO_CONTEXT:
        log("⚠️ Bilgi girilmedi, bağlamsız devam ediliyor.")

def ensure_chars():
    """Face-swap sorgusu + char_refs/ görsellerini yükle."""
    global CHAR_REFS, SWAP_ON
    force = "--chars" in sys.argv
    swap = None
    if SWAP_FLAG_FILE.exists() and not force:
        swap = SWAP_FLAG_FILE.read_text(encoding="utf-8").strip().lower()
    if swap not in ("yes","no"):
        log("\n" + "="*60)
        log("🎭 Bu videoda FACE-SWAP yaptın mı? (karakterlerin yüzü/saçı değişti mi)")
        log("   Evet ise char_refs/ klasörüne her karakterin net bir görselini koy")
        log("   (baby.png, brother.png, mother.png ...). [e/h]")
        log("="*60)
        try:
            ans = input().strip().lower()
        except EOFError:
            ans = "h"
        swap = "yes" if ans in ("e","evet","y","yes") else "no"
        SWAP_FLAG_FILE.write_text(swap, encoding="utf-8")
    if swap != "yes":
        log("🎭 Face-swap yok — karakterler videodaki gibi."); return
    SWAP_ON = True
    if not CHAR_REFS_DIR.exists():
        log(f"⚠️ Swap=evet ama klasör yok: {CHAR_REFS_DIR} — referanssız devam."); return
    exts = (".png",".jpg",".jpeg",".webp")
    files = sorted([p for p in CHAR_REFS_DIR.iterdir() if p.suffix.lower() in exts])
    for p in files:
        b64 = encode_image(p)
        if b64:
            CHAR_REFS.append((p.stem, b64))   # p.stem = "baby", "brother"...
    if CHAR_REFS:
        log(f"🎭 {len(CHAR_REFS)} karakter referansı yüklendi: {', '.join(n for n,_ in CHAR_REFS)}")
        log("   (yeniden sormak için: --chars)")
    else:
        log(f"⚠️ char_refs/ boş — referanssız devam.")

def main():
    if not GEMINI_API_KEY:
        log('❌ export GEMINI_API_KEY="..." gerekli'); sys.exit(1)
    setup_project()
    ensure_context()
    ensure_chars()

    all_scenes = load_scenes(SOURCE_JSON)
    lo, hi = SCENE_RANGE
    # --scenes N-M veya --scenes N argümanı (opsiyonel); yoksa tüm sahneler
    if "--scenes" in sys.argv:
        i = sys.argv.index("--scenes")
        if i+1 < len(sys.argv):
            arg = sys.argv[i+1]
            try:
                if "-" in arg:
                    a,b = arg.split("-"); lo,hi = int(a),int(b)
                else:
                    lo = hi = int(arg)
            except ValueError:
                log(f"❌ --scenes formatı hatalı: '{arg}' (örn: --scenes 9-20 veya --scenes 12)")
                sys.exit(1)
        else:
            log("❌ --scenes değer bekliyor (örn: --scenes 9-20)"); sys.exit(1)
    scenes = [s for s in all_scenes if lo <= s["index"] <= hi]
    log("="*60)
    log(f"GEMINI DIRECT — optimizer-dostu v1/v2/v3 | sahne {lo}-{hi} ({len(scenes)})")
    log("="*60)

    client = genai.Client(api_key=GEMINI_API_KEY)
    vid = upload_or_cache(client)

    # mevcut prompts'u yükle (MERGE — diğer sahneler korunur)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    existing = {}
    if PROMPTS_JSON.exists():
        cur = json.loads(PROMPTS_JSON.read_text())
        cur = cur["scenes"] if isinstance(cur, dict) and "scenes" in cur else cur
        existing = {p["index"]: p for p in cur if "index" in p}
        log(f"📄 Mevcut prompts: {len(existing)} sahne (korunacak, sadece {lo}-{hi} güncellenir)")

    label_by_idx = {s["index"]: s.get("label", f"scene_{s['index']:03d}") for s in all_scenes}
    fm_by_idx    = {s["index"]: s.get("frame_mode","both") for s in all_scenes}
    desc_by_idx  = {s["index"]: normalize_char((s.get("scene_description") or "").strip()) for s in all_scenes}
    # Studio metadata'sini runner icin tasi (prompts JSON tek okuma kaynagi). YOKSA None (eski format).
    vdur_by_idx  = {s["index"]: s.get("video_duration") for s in all_scenes}
    vmodel_by_idx = {s["index"]: s.get("video_model") for s in all_scenes}
    alt_by_idx   = {s["index"]: s.get("alternative_scene") for s in all_scenes}   # sahne-basi varyant sayisi

    overlay_cues = []
    # mevcut overlay cue'ları yükle (MERGE — bu aralık dışındakiler korunur)
    overlay_prev = []
    if OVERLAY_JSON.exists():
        try:
            prev = json.loads(OVERLAY_JSON.read_text())
            if isinstance(prev, list):
                overlay_prev = [c for c in prev
                                if isinstance(c, dict) and not (lo <= c.get("scene_index",-1) <= hi)]
        except Exception:
            log("⚠️ overlay_cues.json okunamadı — üstüne yazılacak")
    BATCH = 1    # tek tek: bir sahne bloklanırsa komşuları etkilenmesin
    for i in range(0, len(scenes), BATCH):
        batch = scenes[i:i+BATCH]
        log(f"\n── Batch {i//BATCH+1} ({len(batch)} sahne): {[s['index'] for s in batch]} ──")
        try:
            res = gen_batch(client, vid, batch)
        except Exception as e:
            log(f"   ❌ API hatası: {e}"); res = None
        if not res:
            log("   ⚠️ boş yanıt, batch atlandı"); continue
        rmap = {}
        for r in res:
            if isinstance(r, dict) and "scene_index" in r:
                try: rmap[int(r["scene_index"])] = r
                except (ValueError, TypeError): pass
        for pos, s in enumerate(batch):
            idx = s["index"]; r = rmap.get(idx)
            if r is None and len(res) == len(batch):
                r = res[pos]          # pozisyonel fallback (sıra = batch sırası)
            if not isinstance(r, dict) or not r.get("v1"):
                log(f"   ⚠️ {idx:03d} eşleşme yok / boş v1"); continue
            face_vis = r.get("face_visible", True)
            if isinstance(face_vis, str): face_vis = face_vis.strip().lower() not in ("false","no","0")
            entry = {
                "index": idx, "label": label_by_idx[idx], "frame_mode": fm_by_idx[idx],
                "scene_desc": desc_by_idx[idx], "scene_type": "manual",
                "v1": clip(normalize_char(r.get("v1","")), MAX_V1, True,  face_vis),
                "v2": clip(normalize_char(r.get("v2","")), MAX_V2, False, face_vis),
                "v3": clip(normalize_char(r.get("v3","")), MAX_V3, True,  face_vis),
                "emotion": r.get("emotion",""), "face_visible": face_vis, "source": "gemini_direct",
                "video_duration": vdur_by_idx.get(idx), "video_model": vmodel_by_idx.get(idx),
                "alternative_scene": alt_by_idx.get(idx),
            }
            existing[idx] = entry
            if SELF_CHECK:
                entry, changed = self_check(client, entry, face_vis)
                fv2 = entry.get("face_visible", face_vis)
                # self-check sonrası tag/ışık temizliğini tekrar uygula
                entry["v1"] = clip(normalize_char(entry.get("v1","")), MAX_V1, True,  fv2)
                entry["v2"] = clip(normalize_char(entry.get("v2","")), MAX_V2, False, fv2)
                entry["v3"] = clip(normalize_char(entry.get("v3","")), MAX_V3, True,  fv2)
                existing[idx] = entry
                if changed: log(f"      ✏️ self-check düzeltti: {', '.join(changed)}")
                else: log(f"      ✓ self-check: temiz")
            ov = r.get("fx_overlay")
            if ov and ov != "none" and isinstance(ov, dict):
                ov.update({"scene_index": idx, "scene_label": label_by_idx[idx]})
                overlay_cues.append(ov)
            for k, mx in (("v1",MAX_V1),("v2",MAX_V2),("v3",MAX_V3)):
                if len(entry.get(k,"")) > mx:
                    log(f"      ⚠️ {k} uzun: {len(entry[k])}>{mx} karakter (kırpılmadı — gözden geçir)")
            log(f"   ✅ {idx:03d} [{entry['emotion']}]")
            log(f"      v1: {entry['v1'][:75]}...")
            log(f"      v2: {entry['v2'][:75]}...")
            log(f"      v3: {entry['v3'][:75]}...")
        # her batch sonrası kaydet
        out = sorted(existing.values(), key=lambda x: x["index"])
        PROMPTS_JSON.write_text(json.dumps(out, indent=2, ensure_ascii=False))
        if i + BATCH < len(scenes): time.sleep(3)

    out = sorted(existing.values(), key=lambda x: x["index"])
    PROMPTS_JSON.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    overlay_all = sorted(overlay_prev + overlay_cues, key=lambda c: c.get("scene_index", 0))
    if overlay_all or OVERLAY_JSON.exists():
        OVERLAY_JSON.write_text(json.dumps(overlay_all, indent=2, ensure_ascii=False))

    # okunabilir TXT (sadece bu aralık)
    txt = [f"GEMINI DIRECT — scene {lo}-{hi}\n{'='*50}"]
    for p in out:
        if lo <= p["index"] <= hi:
            txt += [f"\n--- Scene {p['index']:03d} [{p['frame_mode']}] [{p.get('emotion','')}] ---",
                    f"NOTE: {p['scene_desc'][:90]}",
                    f"V1: {p['v1']}", f"V2: {p['v2']}", f"V3: {p['v3']}"]
    (OUTPUT_DIR / "gemini_direct_review.txt").write_text("\n".join(txt), encoding="utf-8")

    log(f"\n{'='*60}")
    log(f"✅ TAMAM — {lo}-{hi} arası güncellendi (toplam {len(out)} sahne dosyada)")
    log(f"📄 {PROMPTS_JSON}")
    log(f"📄 Review: {OUTPUT_DIR/'gemini_direct_review.txt'}")
    if overlay_all: log(f"🎬 Overlay: {OVERLAY_JSON} ({len(overlay_all)} cue — {len(overlay_cues)} yeni, {len(overlay_prev)} korunan)")
    log(f"\n💡 Hailuo'ya göndermeden önce 1-8'i progress'ten sıfırla, sonra --scenes 1-8")

if __name__ == "__main__":
    main()
