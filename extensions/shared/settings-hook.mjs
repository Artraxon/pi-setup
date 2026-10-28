// Pi 1.3 has no public settings-contribution API. Keep one per-TUI hook shared
// by our extensions so reload cleanup is independent of extension order.
const KEY = Symbol.for('pi-local-settings-contributions-v1');
export function contributeSettings(host, contribute) {
    if (typeof host.setFocus !== 'function') return () => {};
    let state = host[KEY];
    if (!state) {
        const previous = host.setFocus;
        state = { previous, handlers: new Set() };
        state.wrapper = function(component, ...args) {
            if (Array.isArray(component?.items) && component.items.some(item => item.id === 'theme') &&
                component.items.some(item => item.id === 'tui-mode')) {
                const count = component.items.length;
                for (const handler of state.handlers) handler(component);
                if (component.items.length !== count) {
                    if (typeof component.applyFilter === 'function') component.applyFilter(component.searchInput?.getValue() || '');
                    else if (Array.isArray(component.filteredItems) && component.filteredItems !== component.items) component.filteredItems = [...component.items];
                }
            }
            return previous.call(this, component, ...args);
        };
        host[KEY] = state;
        host.setFocus = state.wrapper;
    }
    state.handlers.add(contribute);
    return () => {
        state.handlers.delete(contribute);
        if (!state.handlers.size) {
            if (host.setFocus === state.wrapper) host.setFocus = state.previous;
            if (host[KEY] === state) delete host[KEY];
        }
    };
}
