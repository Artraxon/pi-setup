// Minimal protocol-state oracle, NOT a terminal renderer or PNG decoder.
// In Kitty, ED 2 (CSI 2 J) clears graphics data as well as placements. A lower-
// case graphics delete retains data, so treating these as equivalent misses the
// stale-upload-cache bug. See kitty/graphics.c: grman_clear -> filter_refs.
export class KittyState {
    images = new Set();
    placements = new Set();
    missingPlacements = [];
    pending;

    consume(output) {
        for (const match of output.matchAll(/\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\|\x1b\[(?:2|3)J/g)) {
            if (match[1] === undefined) {
                this.images.clear(); this.placements.clear(); this.pending = undefined;
                continue;
            }
            const controls = Object.fromEntries(match[1].split(',').map(pair => pair.split('=')));
            if (controls.a === 'd') {
                if (controls.d === 'I' || controls.d === 'i') {
                    this.placements.delete(controls.i);
                    if (controls.d === 'I') this.images.delete(controls.i);
                } else {
                    if (controls.d === 'A') {
                        for (const id of this.placements) this.images.delete(id);
                    }
                    this.placements.clear();
                }
            } else if (controls.a === 'T' || controls.a === 't' || this.pending) {
                this.pending ??= controls;
                if (controls.m === '1') continue;
                const transmission = this.pending;
                this.pending = undefined;
                this.images.add(transmission.i);
                if (transmission.a === 'T') this.placements.add(transmission.i);
            } else if (controls.a === 'p') {
                if (this.images.has(controls.i)) this.placements.add(controls.i);
                else this.missingPlacements.push(controls.i);
            }
        }
    }
}
