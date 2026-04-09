import template from './sw-admin-menu-item.html.twig';
import './sw-admin-menu-item.scss';

const { createId, types } = Shopware.Utils;

/**
 * @sw-package framework
 *
 * @private
 */
export default {
    template,

    inject: [
        'acl',
        'feature',
    ],

    emits: [
        'menu-item-click',
        'menu-item-hover',
    ],

    props: {
        entry: {
            type: Object,
            required: true,
        },
        parentEntries: {
            type: Array,
            required: false,
            default: () => [],
        },

        displayIcon: {
            type: Boolean,
            // eslint-disable-next-line vue/no-boolean-default
            default: true,
            required: false,
        },
        iconSize: {
            type: String,
            default: '16px',
            required: false,
        },
        collapsibleText: {
            type: Boolean,
            // eslint-disable-next-line vue/no-boolean-default
            default: true,
            required: false,
        },
        sidebarExpanded: {
            type: Boolean,
            // eslint-disable-next-line vue/no-boolean-default
            default: true,
            required: false,
        },
        isExpanded: {
            type: Boolean,
            default: false,
            required: false,
        },
        borderColor: {
            type: String,
            default: '#333',
            required: false,
        },
    },

    computed: {
        getLinkToProp() {
            if (this.entry.params) {
                return { name: this.entry.path, params: this.entry.params };
            }

            return { name: this.entry.path };
        },

        getEntryLabel() {
            if (this.entry.label instanceof Object) {
                return this.entry.label.translated ? this.entry.label.label : this.$tc(this.entry.label.label);
            }
            return this.$tc(this.entry.label);
        },

        showMenuItem() {
            // special case for settings module, children are stored in a global state store
            if (this.entry.path === 'sw.settings.index') {
                return this.acl.hasActiveSettingModules();
            }

            if (this.children.length > 0) {
                return true;
            }

            if (this.getLinkToProp && this.getLinkToProp.name) {
                const { name } = this.getLinkToProp;

                return this.hasAccessToRoute(name);
            }

            return false;
        },

        entryPath() {
            if (this.entry.path && this.hasAccessToRoute(this.entry.path)) {
                return this.entry.path;
            }

            return undefined;
        },

        children() {
            return this.entry.children.filter((child) => {
                if (!child.privilege) {
                    return true;
                }

                return this.acl.can(child.privilege);
            });
        },

        expandIcon() {
            return this.isExpanded ? 'regular-chevron-up-xs' : 'regular-chevron-down-xs';
        },

        isFirstChild() {
            if (!this.entry.parent) {
                return false;
            }
            const siblings = this.$parent?.children || [];
            return siblings.length > 0 && siblings[0]?.id === this.entry.id;
        },

        isLastChild() {
            if (!this.entry.parent) {
                return false;
            }
            const siblings = this.$parent?.children || [];
            return siblings.length > 0 && siblings[siblings.length - 1]?.id === this.entry.id;
        },
    },

    methods: {
        hasAccessToRoute(path) {
            let route = '';
            let match = false;

            route = `/${path.replace(/[\.\-]/g, '/')}`;
            match = this.$router.resolve({
                path: route,
            });

            if (!match.meta) {
                return true;
            }

            return this.acl.can(match.meta.privilege);
        },

        getIconName(name, isActive = false) {
            if (isActive && typeof name === 'string') {
                if (name.startsWith('regular-')) {
                    return name.replace('regular-', 'solid-');
                }

                if (name.startsWith('icon/regular/')) {
                    return name.replace('icon/regular/', 'icon/solid/');
                }
            }

            return `${name}`;
        },

        getItemName(menuItemName) {
            return menuItemName.replace(/\./g, '-');
        },

        subIsActive(path, entryId) {
            // this is an extra case for the sw-sales-channel menu, without this all sales-channels
            // would have the selection highlight as soon as one is selected.
            if (this.$route.name?.startsWith('sw.sales.channel.') && entryId) {
                return this.$route.params?.id === entryId;
            }

            const meta = this.$route.meta;
            const adminMenuEntries = Shopware.Store.get('adminMenu').adminModuleNavigation;
            let compareTo;

            function findRootEntry(currentPath, foundPaths = []) {
                const foundEntry = adminMenuEntries.find((entry) => {
                    return entry.path === currentPath || entry.id === currentPath;
                });

                foundPaths.push(foundEntry.path || foundEntry.id);

                if (foundEntry.parent?.length) {
                    return findRootEntry(foundEntry.parent, foundPaths);
                }

                return foundPaths;
            }

            if (meta.$current) {
                const matchingPaths = findRootEntry(meta.$current.path);
                const isInPath = matchingPaths.includes(path);

                // If this item has children and is expanded, don't show as active
                // (let the child show as active instead)
                if (isInPath && this.children.length > 0 && this.isExpanded) {
                    return false;
                }

                return isInPath;
            }

            if (meta.parentPath) {
                compareTo = meta.parentPath;
            }

            if (meta.$module?.navigation?.[0].parent) {
                compareTo = meta.$module.navigation[0].parent;
            }

            if (!compareTo) {
                compareTo = this.$route?.name;
            }

            if (this.entry.path) {
                const isActive = compareTo
                    ? compareTo.replace(/-/g, '.').indexOf(path.replace(/\.index/g, '')) === 0
                    : false;

                // If this item has children and is expanded, don't show as active
                // (let the child show as active instead)
                if (isActive && this.children.length > 0 && this.isExpanded) {
                    return false;
                }

                return isActive;
            }

            return this.entry.id === compareTo;
        },

        getElementClasses(menuItemName) {
            const name = menuItemName.replace(/\./g, '-');
            const hasChildren = this.entry.children.length > 0;
            const convertName = this.entry.id || this.entry.path;
            const convertedId = convertName.replace(/\./g, '-');

            return [
                convertedId,
                `navigation-list-item__type-${this.entry.moduleType}`,
                `navigation-list-item__${name}`,
                `sw-admin-menu__item--${this.entry.id}`,
                `navigation-list-item__level-${this.entry.level}`,
                { 'navigation-list-item__has-children': hasChildren },
            ];
        },

        isFirstPluginInMenuEntries(entry, menuEntries) {
            const firstPluginEntry = menuEntries.find((menuEntry) => {
                return menuEntry.moduleType === 'plugin';
            });

            if (!firstPluginEntry) {
                return false;
            }
            return types.isEqual(entry, firstPluginEntry);
        },

        getCustomKey(path) {
            return `${path}-${createId()}`;
        },
    },
};
