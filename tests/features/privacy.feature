Feature: Privacy filtering
  As someone who does not want to be followed between sites
  I want requests filtered and headers normalised before they leave the machine
  So that visiting a page does not announce who I am

  Specification section 4 warns about three specific ways this goes wrong
  quietly, and each has scenarios here:
    - filter stages registered independently overwrite each other, so they run as
      one ordered pipeline through a single interception point
    - matching name fragments like "track." breaks parcel tracking and newsletters,
      so matching is on whole labels and registrable domains
    - a masked user agent beside client hints that still report the real system is
      a stronger identifier than no masking, so they are normalised together

  Background:
    Given default privacy settings

  Scenario: The pipeline runs in the order the specification prescribes
    Then the filter stage order is "telemetry, blocker, redirect, tracking-params, https-upgrade"

  Scenario: Telemetry endpoints of the engine itself are blocked
    When a "xhr" request is made to "https://optimizationguide-pa.googleapis.com/v1"
    Then the request is blocked by the "telemetry" stage

  Scenario: A telemetry host's subdomains are blocked too
    When a "xhr" request is made to "https://a.b.safebrowsing.googleapis.com/x"
    Then the request is blocked by the "telemetry" stage

  Scenario: An unrelated service on the same provider is not blocked
    When a "stylesheet" request is made to "https://fonts.googleapis.com/css"
    Then the request is allowed

  Scenario: Blocking telemetry wins over cleaning its parameters
    When a "mainFrame" request is made to "https://safebrowsing.googleapis.com/v4?utm_source=x"
    Then the request is blocked by the "telemetry" stage

  Scenario: Tracking parameters are removed from a navigation
    When a "mainFrame" request is made to "https://example.com/article?utm_source=news&id=1"
    Then the request is redirected to "https://example.com/article?id=1"

  Scenario: Subresource URLs are left alone so caching and signatures survive
    When a "script" request is made to "https://cdn.example.com/a.js?utm_source=x"
    Then the request is allowed

  Scenario: A redirector's real destination is followed
    Given the current page is "https://news.example.org/article"
    When a "mainFrame" request is made to "https://go.redirectingat.com/?url=https%3A%2F%2Fshop.example.com%2Fitem"
    Then the request is redirected to "https://shop.example.com/item"

  Scenario: A redirector with no recoverable destination is blocked
    Given the current page is "https://news.example.org/article"
    When a "mainFrame" request is made to "https://anrdoezrs.net/click-1234-5678"
    Then the request is blocked by the "redirect" stage

  Scenario Outline: Legitimate hosts that merely look like trackers are not blocked
    Given the current page is "https://mail.example.com/inbox"
    When a "mainFrame" request is made to "<url>"
    Then the request is allowed

    Examples:
      | url                                        |
      | https://track.dhl.de/shipment/123          |
      | https://click.newsletter.example.com/story |
      | https://tracking.post.example/parcel       |

  Scenario: An unencrypted navigation reaches a real interstitial, not a silent switch
    When a "mainFrame" request is made to "http://example.com/page"
    Then the request is redirected to an "tessera://https-only" page

  Scenario: Unencrypted subresources are upgraded silently
    When a "image" request is made to "http://example.com/a.png"
    Then the request is redirected to "https://example.com/a.png"

  Scenario: Loopback is left alone, having no certificate to upgrade to
    When a "mainFrame" request is made to "http://localhost:5173/index.html"
    Then the request is allowed

  Scenario Outline: Turning a filter off actually stops it filtering
    Given the setting "<setting>" is off
    When a "<type>" request is made to "<url>"
    Then the request is allowed

    Examples:
      | setting                            | type      | url                                             |
      | privacy.blockTelemetryDomains      | xhr       | https://safebrowsing.googleapis.com/x           |
      | privacy.httpsOnlyMode              | mainFrame | http://example.com/page                         |
      | privacy.stripTrackingParameters    | mainFrame | https://example.com/a?utm_source=x              |
      | privacy.blockRedirectTrackers      | mainFrame | https://anrdoezrs.net/click-1                   |

  Scenario: Do Not Track and Global Privacy Control are sent
    When headers are prepared for "https://example.com/"
    Then the header "DNT" is "1"
    And the header "Sec-GPC" is "1"

  Scenario: Turning Do Not Track off removes the header
    Given the setting "privacy.sendDoNotTrack" is off
    When headers are prepared for "https://example.com/"
    Then the header "DNT" is absent

  Scenario: The language header does not disclose a region
    When headers are prepared for "https://example.com/"
    Then the header "Accept-Language" is "en-US,en;q=0.9"

  Scenario: Client hints report the same system as the user agent
    When headers are prepared for "https://example.com/"
    Then the header "Sec-CH-UA-Platform" is "\"Windows\""
    And the header "Sec-CH-UA-Platform-Version" is "\"10.0.0\""
    And the header "Sec-CH-UA-Full-Version-List" is absent

  Scenario: A cross-site referrer is trimmed to the origin
    Given the request carries the referrer "https://source.example/secret/page?q=1"
    When headers are prepared for "https://other.example/target"
    Then the header "Referer" is "https://source.example/"

  Scenario: A same-site referrer is left intact
    Given the request carries the referrer "https://source.example/secret/page?q=1"
    When headers are prepared for "https://www.source.example/target"
    Then the header "Referer" is "https://source.example/secret/page?q=1"

  Scenario: A referrer is dropped entirely on a downgrade to plain HTTP
    Given the request carries the referrer "https://source.example/page"
    When headers are prepared for "http://other.example/target"
    Then the header "Referer" is absent

  Scenario: Third-party cookies are stripped from the response
    Given the current page is "https://example.com/"
    When a response from "https://tracker.example/pixel" sets a cookie
    Then the response has no cookie header

  Scenario: First-party cookies survive across subdomains
    Given the current page is "https://www.example.com/"
    When a response from "https://api.example.com/data" sets a cookie
    Then the response still has its cookie header
