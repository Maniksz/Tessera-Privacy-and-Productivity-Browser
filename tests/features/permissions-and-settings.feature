Feature: Permissions and settings
  As someone who does not want a page taking the camera without asking
  I want every permission refused until I say otherwise
  And I want a setting that flips to actually do something

  Two specification points drive this:
    - section 4: the underlying engine approves camera, microphone, location and
      notifications with no handler installed, so refusing by default has to be
      done actively
    - section 5: a switch that flips but changes nothing is worse than no switch,
      so storing an unknown key must fail visibly

  Background:
    Given default settings

  Scenario Outline: Everything a page can ask for is refused by default
    When a page requests the "<permission>" permission
    Then the permission is denied

    Examples:
      | permission                |
      | geolocation               |
      | notifications             |
      | clipboard-read            |
      | display-capture           |
      | midi                      |
      | midiSysex                 |
      | storage-access            |
      | top-level-storage-access  |

  Scenario Outline: Device buses and sensors are refused regardless of settings
    Given the setting "<setting>" is "allow"
    When a page requests the "<permission>" permission
    Then the permission is denied

    Examples:
      | permission       | setting                 |
      | usb              | permissions.camera      |
      | serial           | permissions.camera      |
      | hid              | permissions.camera      |
      | bluetooth        | permissions.camera      |
      | idle-detection   | permissions.camera      |

  Scenario: Fullscreen is granted, because tile fullscreen depends on it
    When a page requests the "fullscreen" permission
    Then the permission is allowed

  Scenario: A permission the browser has never heard of is refused
    When a page requests the "some-future-capability" permission
    Then the permission is denied

  Scenario: Camera can be granted individually
    Given the setting "permissions.camera" is "allow"
    When a page requests camera access
    Then the permission is allowed

  Scenario: A request for camera and microphone needs both
    Given the setting "permissions.camera" is "allow"
    And the setting "permissions.microphone" is "deny"
    When a page requests camera and microphone access
    Then the permission is denied

  Scenario: A request that asks is neither granted nor refused outright
    Given the setting "permissions.geolocation" is "ask"
    When a page requests the "geolocation" permission
    Then the permission decision is "ask"

  Scenario: An unanswered prompt counts as refused
    Given the setting "permissions.geolocation" is "ask"
    And the user does not answer the prompt
    When a page requests the "geolocation" permission through the browser
    Then the permission is denied

  Scenario: Storing a valid setting works and reads back
    When I set "appearance.theme" to "dark"
    Then reading "appearance.theme" gives "dark"

  Scenario: An unknown key fails visibly instead of being dropped
    When I try to set "appearance.thereIsNoSuchKey" to "dark"
    Then the write fails with "UnknownSettingKeyError"

  Scenario: A value outside its allowed range is refused
    When I try to set "appearance.defaultZoom" to 9999
    Then the write fails with "InvalidSettingValueError"
    And reading "appearance.defaultZoom" gives 100

  Scenario: A value of the wrong type is refused
    When I try to set "privacy.blockerEnabled" to "yes please"
    Then the write fails with "InvalidSettingValueError"

  Scenario: Writing the same value again is not reported as a change
    When I set "appearance.theme" to "dark"
    And I set "appearance.theme" to "dark"
    Then the second write reports no change

  Scenario: Listeners hear about a change and can stop listening
    When I start listening for setting changes
    And I set "appearance.theme" to "light"
    And I stop listening for setting changes
    And I set "appearance.theme" to "dark"
    Then the listener saw 1 change

  Scenario: Settings survive a restart
    When I set "privacy.blockerEnabled" to false
    And the settings are written and read back
    Then reading "privacy.blockerEnabled" gives false

  Scenario: A key from a newer version is kept rather than destroyed
    Given the settings file contains an unknown key "from.the.future"
    When the settings are read
    Then the unknown key is reported
    And the settings file still contains "from.the.future" after a write

  Scenario Outline: Web content cannot reach the core over IPC
    When a sender on "<origin>" calls "<channel>"
    Then the call is refused

    Examples:
      | origin                    | channel          |
      | https://evil.example      | settings:set     |
      | https://evil.example      | quicklinks:list  |
      | http://localhost:5173     | tabs:close       |

  Scenario Outline: An internal page may only use its own narrow allowlist
    When a sender on "tessera://start" calls "<channel>"
    Then the call is "<outcome>"

    Examples:
      | channel           | outcome  |
      | quicklinks:list   | allowed  |
      | quicklinks:create | allowed  |
      | i18n:getCatalog   | allowed  |
      | settings:set      | refused  |
      | tabs:close        | refused  |
      | split:setLayout   | refused  |
      | window:close      | refused  |

  Scenario: The chrome UI may use every channel
    When the chrome UI calls "settings:set"
    Then the call is allowed
