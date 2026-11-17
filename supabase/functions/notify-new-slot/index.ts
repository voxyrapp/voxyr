
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push";
import { authenticateRequest, jsonError } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getFCMAccessToken(): Promise<string> {
  const sa = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT")!);
  const now = Math.floor(Date.now() / 1000);

  const encode = (obj: object) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const h = encode({ alg: "RS256", typ: "JWT" });
  const p = encode({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });

  const si = `${h}.${p}`;
  const pemBody = sa.private_key.replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g,
    ""
  );

  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(si)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const jwt = `${si}.${sigB64}`;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await r.json();

  if (!r.ok || !tokenData.access_token) {
    throw new Error(`Falha ao obter token FCM: ${JSON.stringify(tokenData)}`);
  }

  return tokenData.access_token;
}

async function sendFCM(
  token: string,
  title: string,
  body: string,
  data: Record<string, string> = {}
) {
  const sa = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT")!);
  const at = await getFCMAccessToken();

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${at}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data,
          android: {
            priority: "high",
            notification: { sound: "default" },
          },
          apns: {
            payload: {
              aps: {
                sound: "default",
                badge: 1,
              },
            },
          },
        },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`FCM error: ${JSON.stringify(await res.json())}`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
    const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
    const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT")!;

    webpush.setVapidDetails(
      VAPID_SUBJECT,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );

    const { slot_id, exclude_user_id } = await req.json();

    if (!slot_id) {
      throw new Error("slot_id é obrigatório");
    }

    const { data: slot, error: slotError } = await supabase
      .from("slots")
      .select("id, store_id, date, value, publish_at, shifts(name, start_time, end_time)")
      .eq("id", slot_id)
      .single();

    if (slotError || !slot) {
      throw new Error(slotError?.message || "Vaga não encontrada");
    }

    const auth = await authenticateRequest(req, supabase);
    if (!auth.ok) return jsonError(auth.error, auth.status, corsHeaders);

    if (!auth.internal) {
      const role = String(auth.profile.role || "").toLowerCase();
      const allowed =
        role === "admin" ||
        (role === "autonomo" && auth.profile.store_id === slot.store_id);

      if (!allowed) return jsonError("Sem permissão para notificar esta missão.", 403, corsHeaders);
    }

    const slotDate = slot.date;
    const slotStart = slot.shifts?.start_time;

    if (slotDate && slotStart) {
      const startRaw = String(slotStart).slice(0, 5);
      const slotStartAt = new Date(`${slotDate}T${startRaw}:00-03:00`);
      const now = new Date();

      if (!Number.isNaN(slotStartAt.getTime()) && now >= slotStartAt) {
        return new Response(
          JSON.stringify({
            ok: true,
            sent: 0,
            reason: "vaga já iniciada, push não enviado",
          }),
          {
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      }
    }

    const { data: users, error: usersError } = await supabase
      .from("profiles")
      .select("id, full_name, points, status, store_id")
      .eq("status", "aprovado")
      .eq("store_id", slot.store_id)
      .gte("points", 60);

    if (usersError) throw usersError;

    const candidateIds = (users || []).map(u => u.id);

    if (!candidateIds.length) {
      return new Response(
        JSON.stringify({ ok: true, sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: sameDayReservations, error: resError } = await supabase
      .from("reservations")
      .select("profile_id, slot_id, vacancy_id, status")
      .in("profile_id", candidateIds)
      .in("status", ["confirmada", "check-in", "pausa"]);

    if (resError) throw resError;

    const slotIdsToCheck = [
      ...(sameDayReservations || []).map(r => r.slot_id).filter(Boolean),
      ...(sameDayReservations || []).map(r => r.vacancy_id).filter(Boolean),
    ];

    let busyIds = new Set<string>();

    if (slotIdsToCheck.length) {
      const { data: relatedSlots, error: rsError } = await supabase
        .from("slots")
        .select("id, date")
        .in("id", slotIdsToCheck);

      if (rsError) throw rsError;

      const sameDaySlotIds = new Set(
        (relatedSlots || [])
          .filter(s => s.date === slot.date)
          .map(s => s.id)
      );

      busyIds = new Set(
        (sameDayReservations || [])
          .filter(r =>
            sameDaySlotIds.has(r.slot_id) ||
            sameDaySlotIds.has(r.vacancy_id)
          )
          .map(r => r.profile_id)
      );
    }

    const eligibleIds = candidateIds.filter(id => !busyIds.has(id));

    if (!eligibleIds.length) {
      return new Response(
        JSON.stringify({ ok: true, sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: subs, error: subsError } = await supabase
      .from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth, fcm_token")
      .in("user_id", eligibleIds);

    if (subsError) throw subsError;

    let sent = 0;

    const dateBR = slot.date
      ? slot.date.split("-").reverse().join("/")
      : "";

    const startTime = slot.shifts?.start_time?.slice(0, 5) || "";
    const endTime = slot.shifts?.end_time?.slice(0, 5) || "";

    const valueFormatted = Number(slot.value || 0).toLocaleString(
      "pt-BR",
      { style: "currency", currency: "BRL" }
    );

    const title = "🎯 Nova missão disponível!";
    const body = `📅 ${dateBR}  ⏰ ${startTime}${endTime ? ` às ${endTime}` : ""}
💵 ${valueFormatted} — Toque para reservar`;

    for (const sub of subs || []) {
      try {
        if (sub.fcm_token) {
          await sendFCM(
            sub.fcm_token,
            title,
            body,
            {
              url: "/autonomo.html?screen=mercado",
              tag: `slot-${slot.id}`,
            }
          );
        } else if (sub.endpoint) {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.p256dh,
                auth: sub.auth,
              },
            },
            JSON.stringify({
              title,
              body,
              url: "/autonomo.html?screen=mercado",
              tag: `slot-${slot.id}`,
            })
          );
        }

        sent++;
      } catch (err: any) {
        if (
          err?.statusCode === 404 ||
          err?.statusCode === 410 ||
          err?.message?.includes("UNREGISTERED")
        ) {
          await supabase
            .from("push_subscriptions")
            .delete()
            .eq("id", sub.id);
        } else {
          console.error("Erro push:", err);
        }
      }
    }

    return new Response(
      JSON.stringify({ ok: true, sent }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: err?.message || "Erro interno",
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
