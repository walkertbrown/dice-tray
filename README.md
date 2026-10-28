# Dice Tray

Roll dice inside your notes. Write `` `dice: 2d20kh1 + 5` `` and the note shows the result as a small chip you can click to roll again. Hover it to see every die.

It reads the same notation as the Dice Roller plugin's `dice:` blocks, so notes written for that plugin keep working here.

## Writing a roll

Inline, anywhere in a note:

```
`dice: 3d6 + 2`
`dice: d20`
`dice: (1d4 + 2) * 2`
```

Or a block with one roll per line:

````
```dice
2d20kh1 + 5
8d6
```
````

There is also a command, **Roll dice**, that opens a small roller and remembers your last few rolls.

## Notation

| Write | Meaning |
| --- | --- |
| `3d6`, `d20`, `d%` | three six-siders, one d20, one d100 |
| `+ - * / ^ ( )` | arithmetic, with the usual precedence |
| `2d20kh1`, `2d20kl1`, `4d6k3` | keep highest or lowest (`k` alone keeps the highest one) |
| `4d6dl1`, `4d6dh1`, `4d6d1` | drop lowest or highest |
| `1d6!`, `1d6!3`, `1d6!i` | explode on the top face: once, three times, until it stops |
| `1d6!!` | compound: the exploded dice add into one die |
| `1d6!>4` | explode on a condition |
| `4d6r`, `4d6r2`, `4d6ri`, `4d6r<3` | reroll the bottom face once, twice, until it stops, or on a condition |
| `5d10>=8`, `3d6=6`, `3d6=!6` | count the dice that pass instead of adding them |
| `4dF` | Fudge or Fate dice, -1 to 1 |
| `1d66%` | two d6 read as tens and ones |
| `3d[2,5]` | a die with faces from 2 to 5 |
| `8d6s`, `8d6sd`, `3d6u` | sort ascending, sort descending, reroll duplicates |

Flags go after a `|`: `` `dice: 3d6|avg` `` shows the average, `|noform` hides the formula, `|form` shows it, `|nodice` hides the icon, `|none` shows nothing until clicked, `|text(Roll me)` shows a label instead of the number.

A lone d20 glows green on a natural 20 and red on a natural 1.

## Not yet

Rolling from a note's sections, tags, tables and lookup tables (`dice: [[Note]]`, `dice: #tag`) is not in this release. If you use those, keep Dice Roller installed for now; the two plugins can run side by side.

## Privacy

Dice Tray does not use the network, has no accounts, collects nothing and sends nothing. Settings are stored in your vault like any plugin's.

## Install

From Obsidian: Settings → Community plugins → Browse → search "Dice Tray".

By hand: copy `main.js`, `manifest.json` and `styles.css` from the latest release into `<your vault>/.obsidian/plugins/dice-tray/`, then enable it under Community plugins.

## Build

```
npm install
npm test
npm run build
```

MIT licensed.
