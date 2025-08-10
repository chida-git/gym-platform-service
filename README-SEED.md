# Seed di sviluppo
Requisiti: schema MySQL già creato con le tabelle usate dal progetto (gyms, gym_locations, users, partner_users, plans, inventory_slots, subscriptions, bookings, checkins).

## Esecuzione
```bash
cp .env.example .env    # configura credenziali DB
npm install
npm run seed:dev
```

Credenziali Partner (portale):
- **Email**: manager.isola@example.com
- **Password**: partner123!
