Feature: Proxy and kill switch
  As someone who routes this browser through a proxy
  I want every request to take the proxy, and none to leave directly when it fails
  So that a dead proxy costs me pages, never my address

  The requirements these scenarios protect, from the roadmap plan:
    - R20: a manual proxy applies to all traffic, from saving on, without a restart
    - R21: with the kill switch on and a manual proxy, nothing goes out directly, even
      when the proxy fails; the tile then says the proxy is not reachable
    - R22: with the kill switch on and the system setting, the same, once the system
      answers with a direct way
    - R23: in direct mode the text says the kill switch needs a proxy; no tunnel claimed
    - R24: with a proxy in use, WebRTC reveals no address past it
    - AE6: kill switch on, proxy socks5://127.0.0.1:9050 not running — every main
      navigation shows the proxy state, and no connection goes out directly

  Scenario: A manual proxy with the kill switch on leaves no direct way (R21)
    Given a manual proxy "http://proxy:8080" with the kill switch on
    Then the proxy rule is "http://proxy:8080"

  Scenario: The same proxy with the kill switch off falls back to direct
    Given a manual proxy "http://proxy:8080" with the kill switch off
    Then the proxy rule is "http://proxy:8080,direct://"

  Scenario: socks5h is taken as socks5, and socks4 is not taken at all
    Given a manual proxy "socks5h://tor.example:9050" with the kill switch on
    Then the proxy rule is "socks5://tor.example:9050"
    And the proxy address "socks4://tor.example:1080" is refused

  Scenario: A dead proxy under the kill switch shows as such in the tile (AE6)
    Given a manual proxy "socks5://127.0.0.1:9050" with the kill switch on
    When I open "https://example.com/"
    Then the request goes to Chromium under the proxy rule
    When the page fails with -130
    Then the tile says "The proxy server is not responding."

  Scenario: The system setting may send an address directly (R22)
    Given the system proxy setting answers "PROXY a:3128; DIRECT" with the kill switch on
    When I open "https://example.com/"
    Then the kill switch cancels the request
    And the tile says "The kill switch stopped this page: the system setting allows a direct route."

  Scenario: The system setting names only a proxy
    Given the system proxy setting answers "PROXY a:3128" with the kill switch on
    When I open "https://example.com/"
    Then the request goes to Chromium under the proxy rule

  Scenario: With the kill switch off, the system setting decides alone
    Given the system proxy setting answers "DIRECT" with the kill switch off
    When I open "https://example.com/"
    Then the request goes to Chromium under the proxy rule

  Scenario: In direct mode the kill switch says it needs a proxy (R23)
    Then the kill switch text in "en" begins with "Only takes effect with a proxy"
    And the kill switch text in "de" begins with "Wirkt erst mit Proxy"
    And the kill switch label in "en" speaks of the proxy and of no tunnel or VPN
    And the kill switch label in "de" speaks of the proxy and of no tunnel or VPN

  Scenario: WebRTC takes the proxy whenever there is one (R24)
    Given a manual proxy "http://proxy:8080" with the kill switch off
    And the WebRTC setting is "default"
    Then WebRTC may use nothing that bypasses the proxy

  Scenario: Without a proxy, the WebRTC setting applies as chosen
    Given no proxy, with the kill switch on
    And the WebRTC setting is "default"
    Then WebRTC follows the setting "default"
