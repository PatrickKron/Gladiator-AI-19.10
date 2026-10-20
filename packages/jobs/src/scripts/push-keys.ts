/**
 * Web-Push-Schlüssel (VAPID) erzeugen — einmalig beim Selbsthosten:
 *   npm run push:keys
 * Die Ausgabe in die `.env` des Servers übernehmen und API + Worker neu starten.
 * Der private Schlüssel bleibt auf dem Server; ohne ihn ist Push „nicht eingerichtet“,
 * Benachrichtigungen in der App funktionieren trotzdem.
 */
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log('# Gladiator Web-Push (in die Server-.env eintragen):');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:du@example.com  # eigene Kontaktadresse');
