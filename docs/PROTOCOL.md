# mope.io wire protocol (as decoded from client.js, game version 300)

All integers big-endian. `Writer`/`Reader` live in `src/servers/protocol.ts`.

* **string** – `u16 len` + bytes. The client reader drops the *last* byte, so server strings carry a trailing `0x00` counted in `len`; client-written strings have no terminator.
* **bit group** – bytes where bit0 = "another byte follows", bits1..7 = flags in read order. Unread flags are false.
* **positions** – `u16 = world * 4` (world <= 16383). Radius in new-visible records `u32 = rad * 4`; in updates `u16 = rad * 10`. Angle in updates `u16 = deg * 182`, in new-visible `u8 = deg / 2`.

## Client -> server
| id | body |
|----|------|
| 1 | hello: `u32 387730828, u32 gameVersion, u16 w, u16 h, u16 w2, str sessionId` |
| 113 | spawn: `u16 w, u16 h, str nick` |
| 5 | mouse: `i16 worldX, i16 worldY` |
| 21 | boost: `u8 down` |
| 24 | upgrade choice: `u8 index` |
| 17 | resize: `u16 w, u16 h, u16 w2` |
| 11 | quit · 19 chat · 255 ping · 71 login creds · 122 *(local ext.)* open all-animals menu |

## Server -> client
| id | body |
|----|------|
| 2 | session: `str sessionId, u8 mode, u8 season, str serverId, u8 alive, u16 nStatic, static objs` |
| 17 | camera: `u16 gameW, gameH, camX*4, camY*4, zoom*1000` |
| 107 | minimap: `u8 season` + header + region rects |
| 3 | ready · 6 alive-in-game |
| 18 | animal changed: `u8 type, u8 species, u16 sub, u8 change(2 spawn/1 up/0 down), u8 tier, u32 ownId, u32 xpNeeded, u16 abil1, u16 abil2` + 4 lists (`u8 n`, `u8[]`): dangerous animals, edible animals, unused, edible object types |
| 24 | upgrade menu: `u8 spectator, u8 session, u8 timeout, u8 tier, u8 n` + per choice `u8 season, u8 animalType, u8 biome, u8 species, u16 sub, u8 premium, u8 theme, u8 bought, str itemId` |
| 4 | world update (below) |
| 8 | leaderboard · 10 player count · 14 death · 255 ping echo |

### World update (4)
```
u8 nProps, { u8 id, data }*      1 zoom u16/1000 · 3 cam x,y u16/4 · 7 own id u32 · 11 xp u32 · 16 water u8
bitgroup(3)  u8 trees(0)  u8 team(0)
u16 nNew,     { u16 oType, [u16 animalType if oType==2], u32 id, u32 rad*4, u16 x, u16 y, u8 biome,
                [oType!=2: u8 season, u16, u16, u16], bitgroup(spawner,isRect,angleUpd,batch), u8 angle,
                u8 spec, u8 spec2, class-specific tail }*
u16 nUpdated, { u32 id, bitgroup(flags), u8 nProps, { u16 propId, data }* }*     1 pos · 2 rad · 3 angle · 4 hp
u16 nRemoved, { u32 id, u8 hasKiller, [u32 killer] }*
```
Animal tail: `str nick, u16 species, u16 sub, u8 premium, u8 theme, u8 season, u8 vip, bitgroup(52 flags), u16 wins, u8 team`.
Tree (101) tail: `u16 foodType, u8 canopy, u8 eventType`. Lakes (5/9/13): `u16 innerRad*4`.
Types with their own custom class carry extra fields that are not decoded yet (the world generator avoids them).
