Feature: Downloads
  As someone fetching a file from a site I have no reason to trust
  I want the file to land where I expect it, under a name that says what it is
  So that downloading something cannot change anything outside the downloads folder

  Three arguments these scenarios settle, from specification section 9:
    - the filename is chosen by the remote server, so it is hostile input rather than
      untidy input. The whole of it — header, address, Chromium's suggestion — goes
      through one sanitiser, and the failure to be total about is
      `Content-Disposition: attachment; filename="../../.bashrc"`
    - what is on disk is never written down. A download completes and three weeks
      later the user deletes the file; a stored flag would offer "Open" for a file the
      operating system will then refuse to find
    - a private window keeps nothing, and it keeps nothing because the object it holds
      has no path to the file — not because every call site remembers to check

  Scenario Outline: A name the server chose cannot reach outside the downloads folder
    When a download arrives from "https://files.example/get" with the header "<header>"
    Then it is written as "<name>"

    Examples: the oldest bug in file transfer, still shipped regularly
      | header                                             | name       |
      | attachment; filename=../../.bashrc                 | bashrc     |
      | attachment; filename=..%252f..%252fevil.sh         | evil.sh    |
      | attachment; filename=/etc/cron.d/backdoor          | backdoor   |
      | attachment; filename=CON.txt                       | _CON.txt   |
      | attachment; filename=report.pdf...                 | report.pdf |

  Scenario: A server sending a Windows path is naming a file, not a folder to walk
    When a download arrives from "https://files.example/get" with this header:
      """
      attachment; filename="..\..\Windows\System32\evil.exe"
      """
    Then it is written as "evil.exe"

  Scenario: A name that would be drawn back to front is not passed on as it came
    When a download arrives from "https://files.example/get" with a filename that hides its extension behind a right-to-left override
    Then it is written as "invoice_gnp.exe"
    And the name ends in ".exe"

  Scenario: A deliberately mangled name loses to the one the server meant
    When a download arrives from "https://billing.example/invoice" with this header:
      """
      attachment; filename="_____.pdf"; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf
      """
    Then it is written as "Rechnung März.pdf"

  Scenario: A hostile header does not cost the perfectly good name in the address
    When a download arrives from "https://files.example/annual-report.pdf" with the header "attachment; filename=.."
    Then it is written as "annual-report.pdf"

  Scenario: A name too long to write keeps the part that decides which application opens it
    When a download arrives from "https://files.example/get" with a filename of 300 characters ending in ".pdf"
    Then the name is at most 120 characters
    And the name ends in ".pdf"

  Scenario: A download in a private window leaves no record
    Given a private window
    And a download list
    When a download of "https://files.example/report.pdf" starts
    Then the download list is empty
    And the browser does not claim to know that download

  Scenario: A finished download whose file has gone says so, and offers nothing to open
    Given a download list holding:
      | address                     | file       | state     | on disk | received | total  |
      | https://files.example/a.pdf | a.pdf      | completed | no      | 400000   | 400000 |
      | https://files.example/b.zip | b.zip      | completed | yes     | 900000   | 900000 |
    Then the row for "a.pdf" offers no way to open it
    And the row for "a.pdf" says the file was moved or deleted
    And the row for "b.zip" can be opened
    And the row for "b.zip" says nothing about a missing file

  Scenario: A download the user cancelled is not reported as a file somebody moved
    Given a download list holding:
      | address                     | file  | state     | on disk | received | total  |
      | https://files.example/c.iso | c.iso | cancelled | no      | 120000   | 900000 |
    Then the row for "c.iso" offers no way to open it
    And the row for "c.iso" says nothing about a missing file

  Scenario: A download still running when the browser closed does not come back looking alive
    Given a download list
    When a download of "https://files.example/big.iso" starts
    And the browser is closed and started again
    Then the row for "big.iso" is interrupted
    And the row for "big.iso" gives no reason it made up

  Scenario: Clearing the list leaves a download that is still being written
    Given a download list holding:
      | address                     | file    | state       | on disk | received | total   |
      | https://files.example/d.pdf | d.pdf   | completed   | yes     | 200000   | 200000  |
      | https://files.example/e.iso | e.iso   | progressing | no      | 500000   | 4000000 |
    When I clear the download list
    Then the download list holds 1 download
    And the row for "e.iso" is still running

  Scenario: A server that declares no size gets a bar that admits it does not know
    Given a download list holding:
      | address                     | file  | state       | on disk | received | total |
      | https://files.example/f.bin | f.bin | progressing | no      | 300000   | 0     |
    Then the progress for "f.bin" is unknown rather than nought

  Scenario: A server that declares less than it sends cannot overrun the bar
    Given a download list holding:
      | address                     | file  | state       | on disk | received | total |
      | https://files.example/g.bin | g.bin | progressing | no      | 900000   | 400000 |
    Then the progress for "g.bin" is full rather than past full

  Scenario: A paused download is not a finished one
    Given a download list holding:
      | address                     | file  | state  | on disk | received | total   |
      | https://files.example/h.iso | h.iso | paused | no      | 500000   | 4000000 |
    Then the row for "h.iso" can still be paused, resumed or cancelled
