Feature: HTTPS-only interstitial
  As someone who wants every page encrypted
  I want an unencrypted address to stop at a page that says so
  So that I decide whether to continue, and no website decides it for me

  The requirements these scenarios protect, from the roadmap plan:
    - R7: an http:// navigation lands on a page offering "Try HTTPS", "Continue
      unencrypted" and "Go back", while the address bar shows where it was going
    - R8: no website can trigger "Continue", not even by a redirect; the exemption
      holds per host, per session, in memory only, and a private window keeps its own
    - AE1: a foreign 302 onto the interstitial gives no way to load the target
    - AE2: continuing in a private window changes nothing for the normal window

  Background:
    Given a normal window and a private window

  Scenario: An unencrypted address stops at the interstitial
    When I open "http://bank.example/login" in the normal window
    Then the tab is on the interstitial for "http://bank.example/login"
    And the address bar shows "http://bank.example/login"
    And the page offers a way to continue

  Scenario: Continuing loads the page unencrypted, with its own images
    When I open "http://host.example/pfad" in the normal window
    And I press "Continue unencrypted"
    Then the tab shows "http://host.example/pfad"
    And the page's image "http://host.example/logo.png" loads from "http://host.example/logo.png"
    But the page's image "http://other.example/ad.png" loads from "https://other.example/ad.png"

  Scenario: A foreign redirect gives no way to continue (AE1)
    When "evil.example" redirects the normal window to "tessera://https-only?target=http://bank.example/"
    Then the tab is on the interstitial for "http://bank.example/"
    And the page offers no way to continue
    When I open "http://bank.example/" in the normal window
    Then the tab is on the interstitial for "http://bank.example/"

  Scenario: A foreign redirect onto the continue route does nothing (AE1)
    When I open "http://bank.example/" in the normal window
    And "evil.example" redirects the normal window to the continue route with the tab's token
    Then no host is exempt in the normal window
    When I press "Continue unencrypted"
    Then the tab shows "http://bank.example/"

  Scenario: A guessed token is refused
    When "evil.example" redirects the normal window to "tessera://https-only?target=http://bank.example/&t=kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"
    And I press "Continue unencrypted"
    Then the tab is on the interstitial for "http://bank.example/"
    And no host is exempt in the normal window

  Scenario: A token expires after ten minutes
    When I open "http://bank.example/" in the normal window
    And ten minutes pass
    And I press "Continue unencrypted"
    Then the tab is on the interstitial for "http://bank.example/"

  Scenario: A private window's exemption stays in the private window (AE2)
    When I open "http://printer.lan/" in the private window
    And I press "Continue unencrypted"
    Then the tab shows "http://printer.lan/"
    When I open "http://printer.lan/" in the normal window
    Then the tab is on the interstitial for "http://printer.lan/"

  Scenario: Closing the private window forgets its exemptions
    When I open "http://printer.lan/" in the private window
    And I press "Continue unencrypted"
    And I close the private window
    Then no host is exempt in the private window
