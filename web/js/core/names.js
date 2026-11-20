/**
 * Character names.
 *
 * Forever gives every character a first name and a surname, and uniqueness is
 * on the PAIR — two people in the same guild can both be called Lavanta. That
 * makes "just show the first name" ambiguous rather than merely terse, which
 * is a problem on a roster whose whole job is telling people apart.
 *
 * So the display name is the shortest form that stays unambiguous within the
 * roster it's shown in:
 *
 *   Lavanta              nobody else is called Lavanta
 *   Lavanta S.           there's another Lavanta, different surname initial
 *   Lavanta Stormcaller  there's another Lavanta S. too
 *
 * Computed per render against whatever list is on screen, so a name shown on
 * a forty-person raid roster can be longer than the same name shown in a
 * five-person party. That's correct: ambiguity is a property of the context.
 */

export function firstNameOf(character) {
  return character.firstName || String(character.name || "").split(/\s+/)[0] || "";
}

export function lastNameOf(character) {
  if (character.lastName !== undefined) return character.lastName || "";
  return String(character.name || "").split(/\s+/).slice(1).join("") || "";
}

export function fullName(character) {
  const last = lastNameOf(character);
  return last ? `${firstNameOf(character)} ${last}` : firstNameOf(character);
}

/**
 * The shortest unambiguous rendering of a name within `roster`.
 *
 * Pass the roster it appears alongside. Pass nothing and you get the first
 * name, which is right when there's no context to collide with.
 */
export function shortName(character, roster) {
  const first = firstNameOf(character);
  const last = lastNameOf(character);
  if (!last || !roster?.length) return first;

  const others = roster.filter(
    (c) => c.id !== character.id && firstNameOf(c) === first
  );
  if (!others.length) return first;

  const initial = last[0];
  const sameInitial = others.filter((c) => lastNameOf(c)[0] === initial);
  if (!sameInitial.length) return `${first} ${initial}.`;

  return `${first} ${last}`;
}

/** Sort comparator — by first name, then surname. */
export function byName(a, b) {
  return (
    firstNameOf(a).localeCompare(firstNameOf(b)) ||
    lastNameOf(a).localeCompare(lastNameOf(b))
  );
}
