class HeaderPO {

    get avatar() {
        return cy.get(".dropdown .navbar-avatar");
    }

    get notificationCount() {
        return cy.get(".navbar-unread-notifications");
    }

    get openButton() {
        return cy.get(".dropdown-toggle");
    }

    get dashboardLink() {
        return cy.get(".dropdown-menu a").eq(1);
    }

    get settingsLink() {
        return cy.get("a[href=/dashboard/settings]");
    }

    get myEntriesLink() {
        return cy.get("a[href=/dashboard/entries]");
    }

    get myPostsLink() {
        return cy.get("a[href=/dashboard/posts]");
    }

    get myScoresLink() {
        return cy.get("a[href=/dashboard/scores]");
    }

    get logoutLink() {
        return cy.get("a[href=/logout]");
    }

}

export default new HeaderPO();