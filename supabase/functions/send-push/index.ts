
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import webpush from "npm:web-push@3.6.7";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateRequest, jsonError } from "../_shared/auth.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!
);

// Gera access token OAuth2 para FCM V1 usando a service account
async function getFCMAccessToken(): Promise<string> {
  const serviceAccount = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT")!);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encode = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const headerB64 = encode(header);
  const payloadB64 = encode(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  // Importa a chave privada RSA
  const pemKey = serviceAccount.private_key;
  const pemBody = pemKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, "");
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const jwt = `${signingInput}.${signatureB64}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(`Falha ao obter token FCM: ${JSON.stringify(tokenData)}`);
  }

  return tokenData.access_token;
}

// Envia notificação via FCM V1
async function sendFCM(
  fcmToken: string,
  title: string,
  body: string,
  data: Record<string, string> = {}
) {
  const serviceAccount = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT")!);
  const projectId = serviceAccount.project_id;
  const accessToken = await getFCMAccessToken();

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token: fcmToken,
          notification: { title, body },
          data: Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, String(v)])
          ),
          android: {
            priority: "high",
            notification: {
              sound: "default",
              click_action: "FLUTTER_NOTIFICATION_CLICK",
            },
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
    const err = await res.json();
    throw new Error(`FCM error: ${JSON.stringify(err)}`);
  }

  return await res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let parsedBody: any = {};

    try {
      parsedBody = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Body inválido ou vazio" }),
        { status: 400, headers: corsHeaders }
      );
    }

    const { user_id, title, body, data } = parsedBody;

    if (!user_id || !title || !body) {
      return new Response(
        JSON.stringify({ error: "user_id, title e body são obrigatórios" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Autenticação e autorização no servidor.
    const auth = await authenticateRequest(req, supabase);

    if (!auth.ok) {
      return jsonError(auth.error, auth.status, corsHeaders);
    }

    if (!auth.internal) {
      const role = String(auth.profile.role || "").toLowerCase();

      const { data: target, error: targetError } = await supabase
        .from("profiles")
        .select("id, role, store_id")
        .eq("id", user_id)
        .maybeSingle();

      if (targetError || !target) {
        return jsonError("Destinatário não encontrado.", 404, corsHeaders);
      }

      const targetRole = String(target.role || "").toLowerCase();
      let allowed = false;

      if (role === "admin") {
        allowed = true;
      } else if (role === "gerente" || role === "manager") {
        allowed =
          targetRole === "autonomo" &&
          !!auth.profile.store_id &&
          target.store_id === auth.profile.store_id;
      } else if (role === "autonomo") {
        const sameStore =
          !!auth.profile.store_id &&
          target.store_id === auth.profile.store_id;

        if (
          sameStore &&
          ["gerente", "manager"].includes(targetRole)
        ) {
          allowed = true;
        } else if (
          ["admin", "subadmin"].includes(targetRole) &&
          parsedBody.ticket_id
        ) {
          const { data: ticket } = await supabase
            .from("support_tickets")
            .select("id, profile_id, is_urgent")
            .eq("id", parsedBody.ticket_id)
            .eq("profile_id", auth.user.id)
            .eq("is_urgent", true)
            .maybeSingle();

          allowed = !!ticket;
        }
      }

      // Subadmins permanecem bloqueados até validar permissões e lojas.
      if (!allowed) {
        return jsonError("Você não tem permissão para enviar esta notificação.", 403, corsHeaders);
      }
    }

    console.log("user_id recebido:", user_id);

    const { data: subs, error: subsError } = await supabase
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth, fcm_token, user_agent")
      .eq("user_id", user_id);

    if (subsError) {
      console.log("erro ao buscar subscriptions:", subsError);
      throw subsError;
    }

    console.log("subscriptions encontradas:", subs?.length || 0);

    if (!subs || subs.length === 0) {
      return new Response(
        JSON.stringify({ ok: false, message: "Nenhuma subscription encontrada" }),
        { headers: corsHeaders }
      );
    }

    const results = [];

    for (const sub of subs) {
      try {
        // Se tiver fcm_token, usa FCM (app nativo Android/iOS)
        if (sub.fcm_token) {
          console.log("enviando via FCM para token:", sub.fcm_token.slice(0, 20) + "...");

          await sendFCM(sub.fcm_token, title, body, {
            url: data?.url || "/autonomo.html",
            tag: data?.tag || "default",
            type: data?.type || "",
            assignment_id: data?.assignment_id || "",
          });

          results.push({ id: sub.id, type: "fcm", sent: true });
        }
        // Senão usa Web Push (PWA)
        else if (sub.endpoint) {
          console.log("enviando via Web Push para endpoint:", sub.endpoint);

          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            JSON.stringify({
              title,
              body,
              url: data?.url || "/autonomo.html",
              tag: data?.tag || "default",
              type: data?.type || null,
              assignment_id: data?.assignment_id || null,
            })
          );

          results.push({ id: sub.id, type: "webpush", sent: true });
        }
      } catch (err: any) {
        console.log("erro no envio:", err?.message || err);

        // Remove subscriptions inválidas
        if (
          err?.statusCode === 404 ||
          err?.statusCode === 410 ||
          err?.message?.includes("UNREGISTERED")
        ) {
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        }

        results.push({
          id: sub.id,
          sent: false,
          error: err?.message || String(err),
        });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, total: subs.length, results }),
      { headers: corsHeaders }
    );
  } catch (err: any) {
    console.log("erro geral:", err?.message || err);

    return new Response(
      JSON.stringify({ error: err?.message || "Erro interno" }),
      { status: 500, headers: corsHeaders }
    );
  }
});
