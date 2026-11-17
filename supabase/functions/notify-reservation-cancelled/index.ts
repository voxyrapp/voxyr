
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

    webpush.setVapidDetails(
      Deno.env.get("VAPID_SUBJECT")!,
      Deno.env.get("VAPID_PUBLIC_KEY")!,
      Deno.env.get("VAPID_PRIVATE_KEY")!
    );

    const { user_id, slot_id, reason } = await req.json();

    if (!user_id || !slot_id) {
      throw new Error("user_id e slot_id são obrigatórios");
    }

    const { data: slot } = await supabase
      .from("slots")
      .select("date, shifts(start_time, end_time)")
      .eq("id", slot_id)
      .single();

    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, store_id, role")
      .eq("id", user_id)
      .single();

    const auth = await authenticateRequest(req, supabase);
    if (!auth.ok) return jsonError(auth.error, auth.status, corsHeaders);

    if (!auth.internal) {
      const role = String(auth.profile.role || "").toLowerCase();
      const allowed =
        role === "admin" ||
        (role === "autonomo" && auth.user.id === user_id);

      if (!allowed) return jsonError("Sem permissão para notificar este cancelamento.", 403, corsHeaders);
    }

    const nome = profile?.full_name || "Autônomo";
    const dateBR = slot?.date
      ? slot.date.split("-").reverse().join("/")
      : "";

    const startTime = slot?.shifts?.start_time?.slice(0, 5) || "";
    const endTime = slot?.shifts?.end_time?.slice(0, 5) || "";

    let motivoTexto = "";

    switch (reason) {
      case "user_cancelled":
        motivoTexto = "foi cancelada conforme sua solicitação";
        break;
      case "admin_cancelled":
        motivoTexto = "foi cancelada pela administração";
        break;
      case "points_below_minimum":
        motivoTexto = "foi cancelada porque sua pontuação ficou abaixo do mínimo necessário para manter reservas";
        break;
      case "missed_on_the_way":
        motivoTexto = "foi cancelada por falta de confirmação de \"a caminho\" no prazo";
        break;
      case "missed_checkin":
        motivoTexto = "foi cancelada por ausência de check-in no prazo";
        break;
      default:
        motivoTexto = "foi cancelada";
    }

    const title = "❌ Reserva cancelada";

    const body = `Olá ${nome}, sua missão do dia ${dateBR} • ${startTime}${endTime ? ` às ${endTime}` : ""} ${motivoTexto}. Fique atento a novas oportunidades para continuar lucrando de forma totalmente autônoma.`;

    const { data: subs, error: subsError } = await supabase
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth, fcm_token")
      .eq("user_id", user_id);

    if (subsError) throw subsError;

    let sent = 0;

    for (const sub of subs || []) {
      try {
        if (sub.fcm_token) {
          await sendFCM(
            sub.fcm_token,
            title,
            body,
            {
              url: "/autonomo.html",
              tag: `cancel-${slot_id}`,
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
              url: "/autonomo.html",
              tag: `cancel-${slot_id}`,
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
          console.error("Erro push cancelado:", err);
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
