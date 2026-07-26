Feature: Address bar
  As someone typing into one box
  I want the browser to tell an address from a search term
  So that my typing does not end up at a DNS server by mistake

  The bias is deliberate and stated in the code: guessing "address" wrongly sends
  what was typed to a resolver, which leaks it. Guessing "search" wrongly costs one
  keystroke. So anything ambiguous is a search.

  Scenario Outline: Input that is an address
    When I type "<input>" into the address bar
    Then it is treated as an address
    And it navigates to "<url>"

    Examples:
      | input                    | url                             |
      | example.com              | https://example.com             |
      | http://example.com/path  | http://example.com/path         |
      | https://example.com      | https://example.com/            |
      | mail.google.com/mail/u/0 | https://mail.google.com/mail/u/0 |
      | localhost               | https://localhost               |
      | localhost:5173           | https://localhost:5173          |
      | 192.168.1.1:8080         | https://192.168.1.1:8080        |
      | tessera://settings    | tessera://settings           |
      | example.co.uk            | https://example.co.uk           |

  Scenario Outline: Input that is a search
    When I type "<input>" into the address bar
    Then it is treated as a search

    Examples:
      | input                  |
      | how tall is everest    |
      | example.com and more   |
      | settings               |
      | 3.14                   |
      | 192.168.1              |
      | ?example.com           |
      | slack://channel?id=1   |
      | 2 + 2                  |

  Scenario Outline: Input that must never navigate
    When I type "<input>" into the address bar
    Then it is treated as a search

    Examples:
      | input                        |
      | javascript:alert(1)          |
      | data:text/html,<h1>hi        |
      | blob:https://x/y             |
      | vbscript:msgbox(1)           |

  Scenario: An explicit question mark forces a search
    When I type "?example.com" into the address bar
    Then it is treated as a search
    And the search term is "example.com"

  Scenario: Empty input leaves the current page alone
    When I type "   " into the address bar
    Then nothing happens

  Scenario Outline: Search goes to the configured engine
    Given the search engine is "<engine>"
    When I type "rust traits" into the address bar
    Then it navigates to "<url>"

    Examples:
      | engine     | url                                              |
      | duckduckgo | https://duckduckgo.com/?q=rust%20traits          |
      | mojeek     | https://www.mojeek.com/search?q=rust%20traits    |
      | startpage  | https://www.startpage.com/sp/search?query=rust%20traits |

  Scenario: A custom engine without a placeholder falls back rather than searching for nothing
    Given the search engine is custom with template "https://example.com/"
    When I type "test" into the address bar
    Then it navigates to "https://duckduckgo.com/?q=test"

  Scenario: Query characters are encoded so they cannot alter the query
    When I type "a&b=c" into the address bar
    Then it navigates to "https://duckduckgo.com/?q=a%26b%3Dc"

  Scenario Outline: Tracking parameters are stripped from links
    When the URL "<input>" is cleaned
    Then the result is "<output>"

    Examples:
      | input                                                   | output                             |
      | https://example.com/a?utm_source=x&id=1                 | https://example.com/a?id=1         |
      | https://example.com/a?utm_source=x                      | https://example.com/a              |
      | https://example.com/a?gclid=1&fbclid=2&msclkid=3        | https://example.com/a              |
      | https://example.com/a?q=hello&page=2                    | https://example.com/a?q=hello&page=2 |
      | https://example.com/doc?utm_source=x#part-3             | https://example.com/doc#part-3      |
      | https://open.spotify.com/track/abc?si=xyz               | https://open.spotify.com/track/abc?si=xyz |
      | https://www.youtube.com/watch?v=abc&si=xyz              | https://www.youtube.com/watch?v=abc |
