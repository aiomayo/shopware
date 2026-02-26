import template from './sw-admin-menu.html.twig';
import './sw-admin-menu.scss';
import { computePosition, autoUpdate, offset, flip } from '@floating-ui/dom';

const { Mixin } = Shopware;
const { dom, types } = Shopware.Utils;

/**
 * @sw-package framework
 *
 * @private
 */
export default {
    template,

    inject: [
        'menuService',
        'loginService',
        'userService',
        'appModulesService',
        'feature',
        'customEntityDefinitionService',
    ],

    mixins: [
        Mixin.getByName('notification'),
    ],

    data() {
        return {
            activeEntry: null,
            isOffCanvasShown: false,
            isUserActionsActive: false,
            flyoutEntries: [],
            flyoutTitle: '',
            flyoutColor: '',
            flyoutCloseTimeoutId: null,
            subMenuOpen: false,
            scrollbarOffset: '',
            isUserLoading: true,
            flyoutContentStyle: {
                position: 'fixed',
                top: '0px',
                left: '0px',
                zIndex: '1070',
            },
            flyoutReferenceElement: null,
            flyoutAutoUpdateCleanup: null,
        };
    },

    computed: {
        currentUser() {
            return Shopware.Store.get('session').currentUser;
        },

        isExpanded() {
            return this.adminMenuStore.isExpanded;
        },

        userTitle() {
            if (this.currentUser && this.currentUser.admin) {
                return this.$tc('global.sw-admin-menu.administrator');
            }

            if (this.currentUser && this.currentUser.title && this.currentUser.title.length > 0) {
                return this.currentUser.title;
            }

            if (this.currentUser && this.currentUser.aclRoles && this.currentUser.aclRoles.length > 0) {
                return this.currentUser.aclRoles[0].name;
            }

            if (this.currentUser && this.currentUser.title) {
                return this.currentUser.title;
            }

            return '';
        },

        currentLocale() {
            return Shopware.Store.get('session').currentLocale;
        },

        currentExpandedMenuEntries() {
            return this.adminMenuStore.expandedEntries;
        },

        adminModuleNavigation() {
            const adminModuleNavigationEntries = this.adminMenuStore.adminModuleNavigation;

            // Throw an console error if navigation entry is on level 4 or higher. Also remove the navigation entry from menu
            return adminModuleNavigationEntries.filter((entry) => {
                const levelOneParent = adminModuleNavigationEntries.find((e) => entry.parent && e.id === entry.parent);
                // eslint-disable-next-line max-len
                const levelTwoParent = adminModuleNavigationEntries.find(
                    (e) => levelOneParent?.parent && e.id === levelOneParent?.parent,
                );
                // eslint-disable-next-line max-len
                const levelThreeParent = adminModuleNavigationEntries.find(
                    (e) => levelTwoParent?.parent && e.id === levelTwoParent?.parent,
                );

                if (levelThreeParent) {
                    Shopware.Utils.debug.error(
                        new Error(
                            `The navigation entry "${entry.id}" is nested on level 4 or higher.\
The admin menu only supports up to three levels of nesting.`,
                        ),
                    );

                    return false;
                }

                return true;
            });
        },

        appModuleNavigation() {
            return this.adminMenuStore.appModuleNavigation;
        },

        navigationEntries() {
            return [
                ...this.adminModuleNavigation,
                ...this.appModuleNavigation,
                ...this.extensionModuleNavigation,
                ...this.customEntityDefinitionService.getMenuEntries(),
            ];
        },

        mainMenuEntries() {
            const tree = new Shopware.Helper.FlatTreeHelper((first, second) => first.position - second.position);

            this.navigationEntries.forEach((module) => tree.add(module));

            return tree.convertToTree();
        },

        sidebarCollapseIcon() {
            return this.isExpanded ? 'regular-chevron-circle-left' : 'regular-chevron-circle-right';
        },

        userActionsToggleIcon() {
            return this.isUserActionsActive ? 'regular-chevron-down-xs' : 'regular-chevron-up-xs';
        },

        scrollbarOffsetStyle() {
            return {
                right: this.scrollbarOffset,
                'margin-left': this.scrollbarOffset,
            };
        },

        adminMenuClasses() {
            return {
                'is--expanded': this.isExpanded,
                'is--collapsed': !this.isExpanded,
                'is--off-canvas-shown': this.isOffCanvasShown,
            };
        },

        userName() {
            if (!this.currentUser) {
                return '';
            }

            return `${this.currentUser.firstName} ${this.currentUser.lastName}`;
        },

        avatarUrl() {
            if (this.currentUser && this.currentUser.avatarMedia) {
                return this.currentUser.avatarMedia.url;
            }

            return null;
        },

        firstName() {
            return this.currentUser ? this.currentUser.firstName : '';
        },

        lastName() {
            return this.currentUser ? this.currentUser.lastName : '';
        },

        extensionMenuItems() {
            return Shopware.Store.get('menuItem').menuItems;
        },

        extensionModuleNavigation() {
            return this.extensionMenuItems.map((extensionMenuItem) => {
                return {
                    id: Shopware.Utils.createId(),
                    label: extensionMenuItem.label,
                    position: extensionMenuItem.position ?? 110,
                    parent: extensionMenuItem.parent ?? 'sw-extension',
                    moduleType: 'plugin',
                    path: 'sw.extension.sdk.index',
                    params: {
                        id: extensionMenuItem.moduleId,
                    },
                };
            });
        },

        adminMenuStore() {
            return Shopware.Store.get('adminMenu');
        },
    },

    watch: {
        isExpanded() {
            this.toggleSidebar();
        },
        flyoutEntries(entries) {
            if (!entries.length) {
                this.stopFlyoutAutoUpdate();
                return;
            }

            this.$nextTick(() => {
                this.startFlyoutAutoUpdate();
            });
        },
    },

    created() {
        this.createdComponent();
    },

    mounted() {
        this.mountedComponent();
        document.addEventListener('click', this.onDocumentClickDismissFlyout, false);
    },

    beforeUnmount() {
        document.removeEventListener('click', this.onDocumentClickDismissFlyout, false);
        this.cancelFlyoutClose();

        this.beforeUnmountedComponent();
    },

    methods: {
        createdComponent() {
            this.loginService.notifyOnLoginListener();

            this.collapseMenuOnSmallViewports();
            this.getUser();

            Shopware.Utils.EventBus.on('sw-admin-menu/toggle-offcanvas', this.onToggleCanvas);

            this.initNavigation();
        },

        beforeUnmountedComponent() {
            Shopware.Utils.EventBus.off('sw-admin-menu/toggle-offcanvas', this.onToggleCanvas);
            this.stopFlyoutAutoUpdate();
        },

        onToggleCanvas(state) {
            this.isOffCanvasShown = state;
        },

        initNavigation() {
            this.adminMenuStore.adminModuleNavigation = this.menuService.getNavigationFromAdminModules();

            this.refreshApps();
        },

        refreshApps() {
            return this.appModulesService.fetchAppModules().then((modules) => {
                Shopware.Store.get('shopwareApps').apps = modules;
            });
        },

        collapseAdminMenu() {
            this.adminMenuStore.collapseSidebar();
        },

        expandAdminMenu() {
            this.adminMenuStore.expandSidebar();
        },

        mountedComponent() {
            const that = this;

            this.$device.onResize({
                listener() {
                    that.collapseMenuOnSmallViewports();
                },
                component: this,
            });

            this.addScrollbarOffset();
        },

        getUser() {
            this.isUserLoading = true;

            this.userService.getUser().then((response) => {
                const userData = response.data;
                delete userData.password;

                Shopware.Store.get('session').setCurrentUser(userData);

                this.isUserLoading = false;
            });
        },

        collapseMenuOnSmallViewports() {
            if (this.$device.getViewportWidth() <= 1200 && this.$device.getViewportWidth() >= 500) {
                this.collapseAdminMenu();
            }

            if (this.$device.getViewportWidth() <= 500) {
                this.expandAdminMenu();
            }
        },

        isActiveItem(menuItem) {
            return this.isExpanded && menuItem.classList.contains('router-link-active');
        },

        onToggleSidebar() {
            if (this.isExpanded) {
                this.collapseAdminMenu();
            } else {
                this.expandAdminMenu();
            }

            this.toggleSidebar();
        },

        toggleSidebar() {
            if (!this.isExpanded) {
                this.removeClassesFromElements(
                    Array.from(this.$el.querySelectorAll('.sw-admin-menu__navigation-list-item')),
                    ['is--entry-expanded'],
                );

                const currentActiveElement = this.$el.querySelector('a.router-link-active');
                const currentActiveParentElement = currentActiveElement?.parentElement;
                const parentIsFirstLevel = currentActiveParentElement?.classList?.contains('navigation-list-item__level-1');

                const ignoreElementsList = [currentActiveParentElement];

                if (currentActiveElement && !parentIsFirstLevel) {
                    const mainMenuListItem = currentActiveElement.closest(
                        '.navigation-list-item__level-1.navigation-list-item__has-children',
                    );
                    if (mainMenuListItem?.firstElementChild) {
                        ignoreElementsList.push(mainMenuListItem.firstElementChild);
                    }
                }

                this.removeClassesFromElements(
                    Array.from(
                        this.$el.querySelectorAll(
                            '.navigation-list-item__level-1.navigation-list-item__has-children > .router-link-active',
                        ),
                    ),
                    ['router-link-active'],
                    ignoreElementsList,
                );
                this.onFlyoutLeave();
            }

            this.isUserActionsActive = false;
            this.flyoutEntries = [];
        },

        onToggleUserActions() {
            if (this.isUserLoading) {
                return false;
            }
            this.isUserActionsActive = !this.isUserActionsActive;
            return true;
        },

        openUserActions() {
            if (this.isExpanded || this.isUserLoading) {
                return;
            }

            this.isUserActionsActive = true;
        },

        closeUserActions() {
            if (this.isExpanded) {
                return;
            }

            this.isUserActionsActive = false;
        },

        onLogoutUser() {
            this.loginService.logout();
            this.adminMenuStore.clearExpandedMenuEntries();
            Shopware.Store.get('session').removeCurrentUser();
            Shopware.Store.get('notification').clearGrowlNotificationsForCurrentUser();
            Shopware.Store.get('notification').clearNotificationsForCurrentUser();
            this.$router.push({
                name: 'sw.login.index',
            });
        },

        addScrollbarOffset() {
            const offset = dom.getScrollbarWidth(this.$refs.swAdminMenuBody);

            this.scrollbarOffset = `-${offset}px`;
        },

        onMenuItemClick(entry, eventTarget) {
            // Same-tick as opening flyout: document listener must not close (see onDocumentClickDismissFlyout).
            this._suppressDocumentFlyoutDismiss = true;

            const target = eventTarget.closest('.sw-admin-menu__navigation-list-item');
            const isClickFromFlyout = Boolean(
                eventTarget.closest('.sw-admin-menu_flyout-holder, .sw-admin-menu__flyout-floating-ui'),
            );
            const level = entry.level;

            const hasChildrenClass = target.classList.contains('navigation-list-item__has-children');
            const children = hasChildrenClass ? this.getChildren(entry) : [];

            if (!this.isExpanded && !isClickFromFlyout) {
                this.expandAdminMenu();
            }

            if (this.flyoutEntries.length) {
                this.flyoutEntries = [];
                this.flyoutTitle = '';
            }

            if (level > 1 || !hasChildrenClass) {
                return;
            }

            const firstChild = target.firstChild;
            this.removeClassesFromElements(
                Array.from(this.$el.querySelectorAll('.sw-admin-menu__navigation-list-item')),
                [
                    'is--entry-expanded',
                    'is--flyout-expanded',
                ],
                [
                    target,
                    firstChild,
                ],
            );

            const isEntryExpanded = target.classList.contains('is--entry-expanded');

            if (isEntryExpanded) {
                this.adminMenuStore.collapseMenuEntry(entry);

                firstChild.classList.remove('is--entry-expanded');
            } else {
                this.adminMenuStore.clearExpandedMenuEntries();
                this.adminMenuStore.expandMenuEntry(entry);

                target.classList.add('is--entry-expanded');
            }

            target.classList.remove('is--flyout-expanded');
        },

        onMenuItemHover(entry, eventTarget) {
            if (this.isExpanded) {
                return;
            }

            this.cancelFlyoutClose();

            const target = eventTarget.closest('.sw-admin-menu__navigation-list-item');

            if (!target) {
                return;
            }

            const hasChildrenClass = target.classList.contains('navigation-list-item__has-children');
            const children = hasChildrenClass ? this.getChildren(entry) : [];

            if (!hasChildrenClass || children.length === 0) {
                this.onFlyoutLeave();
                return;
            }

            const entryKey = entry.id || entry.path;
            const active = this.activeEntry?.entry;
            const activeKey = active ? active.id || active.path : null;

            if (activeKey === entryKey && this.flyoutEntries.length > 0) {
                return;
            }

            this.flyoutReferenceElement = target.querySelector('.sw-admin-menu__navigation-link') ?? target;
            this.flyoutEntries = children;
            this.flyoutTitle = this.getEntryLabel(entry);
            this.deactivatePreviousMenuItem();
            target.classList.add('is--flyout-enabled');

            if (entry.level && entry.level > 1) {
                const parentEntry = this.mainMenuEntries.find((item) => {
                    return item.id === entry.parent || item.path === entry.parent;
                });
                this.flyoutColor = parentEntry?.color ?? entry.color ?? '';
            } else {
                this.flyoutColor = entry.color ?? '';
            }

            this.activeEntry = { entry, target, parentEntries: [] };
        },

        getVirtualFlyoutReference() {
            if (!this.flyoutReferenceElement) {
                return null;
            }

            return {
                getBoundingClientRect: () => this.flyoutReferenceElement.getBoundingClientRect(),
            };
        },

        startFlyoutAutoUpdate() {
            const reference = this.getVirtualFlyoutReference();
            const floating = this.$refs.flyoutContent;

            if (!reference || !floating) {
                return;
            }

            this.stopFlyoutAutoUpdate();

            this.flyoutAutoUpdateCleanup = autoUpdate(reference, floating, () => {
                computePosition(reference, floating, {
                    placement: 'right-start',
                    strategy: 'fixed',
                    middleware: [
                        offset(12),
                        flip(),
                    ],
                }).then(({ x, y }) => {
                    this.flyoutContentStyle = {
                        ...this.flyoutContentStyle,
                        left: `${x}px`,
                        top: `${y}px`,
                    };
                });
            }, {
                layoutShift: false,
            });
        },

        stopFlyoutAutoUpdate() {
            if (this.flyoutAutoUpdateCleanup) {
                this.flyoutAutoUpdateCleanup();
                this.flyoutAutoUpdateCleanup = null;
            }
        },

        onNavigationListMouseLeave(event) {
            if (event.relatedTarget?.closest('.sw-admin-menu__flyout-content')) {
                return;
            }

            this.scheduleFlyoutClose();
        },

        onFlyoutMouseLeave(event) {
            if (event.relatedTarget?.closest('.sw-admin-menu__navigation-list')) {
                return;
            }

            this.scheduleFlyoutClose();
        },

        scheduleFlyoutClose() {
            if (this.isExpanded || !this.flyoutEntries.length) {
                return;
            }

            this.cancelFlyoutClose();

            this.flyoutCloseTimeoutId = window.setTimeout(() => {
                this.onFlyoutLeave();
            }, 180);
        },

        cancelFlyoutClose() {
            if (this.flyoutCloseTimeoutId) {
                clearTimeout(this.flyoutCloseTimeoutId);
                this.flyoutCloseTimeoutId = null;
            }
        },

        onDocumentClickDismissFlyout() {
            if (this._suppressDocumentFlyoutDismiss) {
                this._suppressDocumentFlyoutDismiss = false;
                return;
            }

            if (!this.flyoutEntries.length || this.isExpanded) {
                return;
            }

            this.onFlyoutLeave();
        },

        getChildren(entry) {
            return entry.children.filter((child) => {
                if (!child.privilege) {
                    return true;
                }

                return this.acl.can(child.privilege);
            });
        },

        onFlyoutLeave() {
            this.cancelFlyoutClose();
            this.deactivatePreviousMenuItem();
            this.stopFlyoutAutoUpdate();
            this.flyoutReferenceElement = null;
            this.flyoutEntries = [];
            this.flyoutTitle = '';
        },

        deactivatePreviousMenuItem() {
            if (this.activeEntry && this.activeEntry.target) {
                this.activeEntry.target.classList.remove('is--flyout-enabled');
            }
            this.activeEntry = null;
        },

        removeClassesFromElements(elements, classList, ignoreElementsList = []) {
            elements.forEach((element) => {
                if (ignoreElementsList.includes(element)) {
                    return;
                }
                element.classList.remove(classList);
            });
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

        getEntryLabel(entry) {
            if (entry.label instanceof Object) {
                return entry.label.translated ? entry.label.label : this.$tc(entry.label.label);
            }

            return this.$tc(entry.label);
        },
    },
};
