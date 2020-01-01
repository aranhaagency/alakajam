import { GANDALF_RANKED_GAME, USER_DUMBLEDORE } from "../support/data";
import entryPo from "../support/page-objects/entry.po";

describe("Event: Ratings", () => {

  beforeEach(() => {
    cy.restoreDB();
    cy.loginAs(USER_DUMBLEDORE);
  });

  afterEach(() => {
    cy.restoreDB();
  });

  it("supports changing submitted themes", () => {
    entryPo.visit(GANDALF_RANKED_GAME);

    cy.scrollElementsToScreenCenter();
    entryPo.votingStar("Awesomeness", 5).click();
    entryPo.votingStar("Beauty", 8).click();

    entryPo.votingRow("Awesomeness").should("contain.text", "5");
    entryPo.votingRow("Beauty").should("contain.text", "8");
  });

});