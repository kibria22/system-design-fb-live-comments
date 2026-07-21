const USER_KEY = "fb_live_user";

const ADJECTIVES = [
  "Swift",
  "Bright",
  "Calm",
  "Bold",
  "Lucky",
  "Quiet",
  "Rapid",
  "Sunny",
];
const NOUNS = [
  "Fox",
  "Owl",
  "River",
  "Cedar",
  "Nova",
  "Pixel",
  "Spark",
  "Wave",
];

export type LocalUser = {
  id: string;
  name: string;
};

function randomName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const n = Math.floor(Math.random() * 900) + 100;
  return `${adj}${noun}${n}`;
}

/** Works on plain HTTP LAN IPs; crypto.randomUUID() needs a secure context. */
function createUserId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  // RFC4122-ish v4 fallback for non-secure contexts (e.g. http://192.168.x.x)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getOrCreateLocalUser(): LocalUser {
  if (typeof window === "undefined") {
    return { id: "", name: "" };
  }

  const existing = sessionStorage.getItem(USER_KEY);
  if (existing) {
    return JSON.parse(existing) as LocalUser;
  }

  const user: LocalUser = {
    id: createUserId(),
    name: randomName(),
  };
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}
