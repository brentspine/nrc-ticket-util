# NRC Ticket Util
Vencord plugin that adds client side utility for the [NRC Ticketbot](https://github.com/NoRiskClient/discord-ticketbot)

Vencord docs: https://deepwiki.com/Vendicated/Vencord

## Prerequisites
- **Node.js 18+** required (specified in engines) [1](#1-0) 
- Git installed

## Then just run the following commands:
```bash
git clone https://github.com/Vendicated/Vencord.git
cd Vencord
npm install -g pnpm@10.4.1
pnpm install --frozen-lockfile
git clone https://github.com/brentspine/nrc-ticket-util src/plugins/nrcTicketUtil
pnpm build
pnpm inject
```

and relaunch Discord
