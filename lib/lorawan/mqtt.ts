import mqtt from "mqtt";

/** Publică un mesaj MQTT (comenzi către module: application/<app>/device/<devEUI>/command/down) și se deconectează; broker-ul e anonim, ca în SCADA. */
export async function publishMqtt(url: string, topic: string, payload: unknown, timeoutMs = 8000): Promise<void> {
  const c = await mqtt.connectAsync(url, { connectTimeout: timeoutMs, reconnectPeriod: 0, clientId: `moldovagaz-${Math.random().toString(16).slice(2, 10)}` });
  try { await c.publishAsync(topic, JSON.stringify(payload), { qos: 0 }); } finally { await c.endAsync(); }
}
