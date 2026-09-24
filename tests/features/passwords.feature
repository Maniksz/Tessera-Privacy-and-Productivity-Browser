Feature: Filling a saved password
  As someone with a password saved for a site
  I want to fill it in from a badge in the field or from the toolbar key
  So that signing in takes one press and one choice, and no page can do it for me

  The requirements these scenarios protect, from the autofill plan
  (docs/plans/2026-08-09-001-feat-password-autofill-trigger-plan.md):
    - R3, R4: nothing is filled before a press the browser itself saw and a choice on the list
    - R14, AE7: the real wiring turns a focus, a press and a choice into a fill
    - AE1: a locked vault answers the press with Unlock, and the list follows the unlock
    - AE3: a page that clicks the badge itself gets nothing
    - AE5: a fill asked for from the toolbar needs no input in the page

  Background:
    Given a sign-in page with a password saved for it

  Scenario: Filling from the badge (AE7)
    When I focus the password field
    And I press the badge
    And I choose the first account
    Then the form is filled with the saved account

  Scenario: A page clicking the badge itself gets nothing (AE3)
    When I focus the password field
    And the page clicks the badge itself
    Then no list appears
    And nothing can be filled

  Scenario: A locked vault answers with Unlock, and the list follows (AE1)
    Given the vault is locked
    When I focus the password field
    And I press the badge
    Then the list says the vault is locked
    When I press Unlock and enter the master password
    Then the list shows the saved account

  Scenario: Filling from the toolbar key without touching the page (AE5)
    When I press the toolbar key
    And I choose the first account
    Then the form is filled with the saved account
