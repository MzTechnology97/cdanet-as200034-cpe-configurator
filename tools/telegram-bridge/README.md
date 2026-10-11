# Ponte Telegram del bot del team

Il bot del gruppo delle segnalazioni gira sul server come piccolo servizio a sé. È **un solo poller**, sempre acceso, e non dipende da un PC o da una sessione di Claude aperta.

- `bridge.mjs` legge i messaggi delle chat ammesse e li salva in `data/inbox.jsonl`:
  - foto, file, video e vocali vanno in `data/files`;
  - su ogni messaggio mette un 👍, così chi scrive sa che è arrivato.
- `cli.mjs` legge e invia:

  ```
  sudo docker exec -i telegram-bridge node cli.mjs status
  sudo docker exec -i telegram-bridge node cli.mjs read            # da leggere (poi segnati letti)
  sudo docker exec -i telegram-bridge node cli.mjs read --peek     # senza segnarli
  sudo docker exec -i telegram-bridge node cli.mjs send gruppo "testo"
  echo "testo lungo" | sudo docker exec -i telegram-bridge node cli.mjs send gruppo
  ```

## Installazione (server)

In `/opt/telegram-bridge`: `docker-compose.yml`, `bridge.mjs`, `cli.mjs` e `telegram.env` (chmod 600, **mai nel repository**):

```
TELEGRAM_BOT_TOKEN=…            # da @BotFather
ALLOWED_CHATS=<id gruppo>,<id utente>
GROUP_CHAT=<id gruppo>
OWNER_CHAT=<id utente>
```

Avvio: `sudo docker compose up -d`. Log: `sudo docker logs telegram-bridge`.

## Una regola sola

Un bot si legge da **un posto solo**. Se il servizio scrive «un altro programma legge lo stesso bot (409)», c'è ancora un altro programma che usa lo stesso token, per esempio il plugin Telegram di Claude sul PC: va chiuso.
