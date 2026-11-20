/**
 * What changed, newest first.
 *
 * Lives in the code rather than the database on purpose: it's release notes,
 * authored by whoever ships a change, and it should move with the deploy that
 * caused it. Add a dated block at the top of the list when you deploy.
 *
 * Types: "added" | "changed" | "fixed" | "note"
 *
 * Written for testers, so each line says what they can now do or what stopped
 * being broken — not which files moved.
 */

export const CHANGELOG = [
  {
    date: "2026-11-13",
    entries: [
      { type: "added", text: "Forever is in Blizzard's API now. Your Forever characters show up when you connect or re-check Battle.net." },
      { type: "added", text: "Add from Battle.net, on the Characters page. Tick the characters you want, pick a spec for each, and they arrive with name, race, class and level filled in." },
      { type: "added", text: "Characters you'd already created are matched to their Battle.net twin by first name, race, class and faction, and show their exact level from then on. If two of yours look identical, neither is matched, so nothing gets mixed up." },
      { type: "note", text: "Levels refresh each time you check Battle.net (from your profile or from the Characters page). Blizzard doesn't let us check in the background." },
      { type: "added", text: "Sign-in now has a second step: after Google, you're asked to connect Battle.net. Already connected? You'll go straight through. Back lets you pick a different Google account; Skip lets you do it later from your profile." },
      { type: "changed", text: "Battle.net now signs in through Blizzard's global login, so players from any region use the same button." },
    ],
  },
  {
    date: "2026-09-18",
    entries: [
      { type: "added", text: "Surnames. Forever gives every character a first name and a family name, so characters now have both. Leave the surname blank for now if you haven't picked one — name reservation opens on 27 October." },
      { type: "added", text: "Names shorten themselves to fit. You'll see just a first name where it's unique, a surname initial where two people share one, and the full name where even that would be ambiguous." },
      { type: "added", text: "Raid calendar. Month view on desktop, a simple list on phones. Every time shows in yours with server time alongside." },
      { type: "added", text: "Raid signups. Pick which character you'd bring and leave a note. Officers accept or decline from a queue." },
      { type: "added", text: "Accepting someone into a raid now clears their signups for other raids that same day, so nobody ends up double-booked." },
      { type: "added", text: "Recurring raids. Pick weekdays and a time, review exactly which dates it produced, untick any you don't want, then create them all at once. Capped to the month you're looking at." },
      { type: "added", text: "Sign up for several raids at once, with quick-pick buttons for a whole weekday." },
      { type: "added", text: "Full raids now say so before you sign up, and put you on the reserve list rather than leaving you wondering." },
      { type: "added", text: "Guild owners can add their own characters to their guild straight from the character card." },
      { type: "added", text: "Weekly resets on the calendar, in your own time. Server reset is Wednesday by default; officers can add raid lockouts with their own days and colours — a three-day lockout like Zul'Gurub shows up twice a week." },
      { type: "added", text: "Raids can be given a colour when you create them, so a month with several different raids reads at a glance instead of being a wall of red." },
      { type: "added", text: "This changelog." },
      { type: "added", text: "Test rosters can now be seeded at level 60 as well as mid-levelling, so the calendar has people who can actually raid." },
    ],
  },
  {
    date: "2026-09-17",
    entries: [
      { type: "added", text: "Guilds. Create one, invite people with a link, and choose which of your characters to bring when you join." },
      { type: "added", text: "Guild Roster board. An ideal composition up top that officers arrange into parties, and everyone who's levelling below, grouped by role and sorted by what the guild is short of." },
      { type: "added", text: "Saved compositions. Store a target raid setup by name and load it back later; raids are created from these." },
      { type: "added", text: "Include alts and include off-specs toggles. Off-specs are marked separately and never counted as real supply." },
      { type: "added", text: "Full and Compact views for the roster board, remembered in your browser." },
      { type: "added", text: "Code of conduct. Guilds set their own, and joining requires agreeing to it." },
      { type: "added", text: "Connect Discord and Battle.net from your profile, with copy buttons for both handles." },
      { type: "added", text: "WhatsApp number and username on your profile, ready for raid reminders later." },
      { type: "changed", text: "Three separate spec fields — main, off-spec and levelling spec — because they mean genuinely different things." },
      { type: "changed", text: "Removing a character now keeps it for 30 days so you can undo it. It never touches your character in game." },
      { type: "fixed", text: "Class colours weren't showing anywhere. They are now, and they stay readable on the light themes." },
      { type: "fixed", text: "Undead Paladin, Human Hunter, Dwarf Shaman, Gnome Priest, Orc Mage and Troll Warlock are all selectable — Forever changes the vanilla rules and we had the old ones." },
      { type: "fixed", text: "Switching language updates the whole page, including the bar at the top." },
      { type: "fixed", text: "Editing a composition no longer reshuffles the party arrangement you'd set up." },
      { type: "note", text: "Forever isn't in Blizzard's API yet, so character levels are still whatever you set them to. The app checks each time you connect Battle.net and will switch over by itself when Blizzard opens it." },
    ],
  },
  {
    date: "2026-09-16",
    entries: [
      { type: "added", text: "Nostalgia Forever went live." },
      { type: "added", text: "Sign in with Google." },
      { type: "added", text: "Characters. Faction, race, class and spec, with only the combinations Forever actually allows." },
      { type: "added", text: "English and Turkish throughout. Class, spec and race names stay in English on purpose." },
      { type: "added", text: "Horde and Alliance colour schemes, each in light and dark." },
      { type: "added", text: "Time zone handling. Raids are set in server time and shown in yours, and the hour of difference when daylight saving moves is handled properly." },
    ],
  },
];
