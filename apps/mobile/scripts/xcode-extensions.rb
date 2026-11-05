# Adds the app's extension targets to ios/App/App.xcodeproj (idempotent).
# The project is committed already wired up; run this only if it was
# regenerated (e.g. `npx cap add ios` from scratch):
#
#   gem install xcodeproj && ruby apps/mobile/scripts/xcode-extensions.rb
#
# Targets:
#   ShareExtension  "Share to NoteApp" (ios/App/ShareExtension)
#   TodayWidget     WidgetKit "Today" widget (ios/App/TodayWidget), if that folder exists
# Both share ios/App/Shared/*.swift with the app and use the App Group in
# their .entitlements files.
require 'xcodeproj'

ROOT = File.expand_path('../ios/App', __dir__)
BUNDLE_ID = 'com.devswartz.noteapp'
DEPLOYMENT_TARGET = '15.0'

proj = Xcodeproj::Project.open(File.join(ROOT, 'App.xcodeproj'))
app = proj.targets.find { |t| t.name == 'App' } or abort 'App target not found'

def group_for(proj, name)
  proj.main_group.find_subpath(name, false) || proj.main_group.new_group(name, name)
end

def add_sources(group, target, files)
  files.each do |path|
    name = File.basename(path)
    ref = group.files.find { |f| f.path == name } || group.new_reference(name)
    target.source_build_phase.add_file_reference(ref, true) unless target.source_build_phase.files_references.include?(ref)
  end
end

# The app's own Swift files that aren't in the project yet (plugin, view controller).
app_group = proj.main_group.find_subpath('App', false)
add_sources(app_group, app, Dir[File.join(ROOT, 'App', '*.swift')])

shared = group_for(proj, 'Shared')
shared_files = Dir[File.join(ROOT, 'Shared', '*.swift')]
add_sources(shared, app, shared_files)

embed = app.copy_files_build_phases.find { |p| p.name == 'Embed Foundation Extensions' } ||
        app.new_copy_files_build_phase('Embed Foundation Extensions').tap { |p| p.symbol_dst_subfolder_spec = :plug_ins }

def add_extension(proj, app, embed, shared, shared_files, name, suffix, frameworks: [])
  dir = File.join(ROOT, name)
  return unless Dir.exist?(dir)
  target = proj.targets.find { |t| t.name == name }
  unless target
    target = proj.new_target(:app_extension, name, :ios, DEPLOYMENT_TARGET, nil, :swift)
    app.add_dependency(target)
    build_file = embed.add_file_reference(target.product_reference, true)
    build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
  end
  group = group_for(proj, name)
  add_sources(group, target, Dir[File.join(dir, '*.swift')])
  add_sources(shared, target, shared_files)
  %w[Info.plist].each { |f| group.files.find { |r| r.path == f } || group.new_reference(f) }
  ent = "#{name}.entitlements"
  group.files.find { |r| r.path == ent } || group.new_reference(ent)
  frameworks.each { |fw| target.add_system_framework(fw) }
  target.build_configurations.each do |c|
    s = c.build_settings
    s['PRODUCT_BUNDLE_IDENTIFIER'] = "#{BUNDLE_ID}.#{suffix}"
    s['PRODUCT_NAME'] = '$(TARGET_NAME)'
    s['INFOPLIST_FILE'] = "#{name}/Info.plist"
    s['GENERATE_INFOPLIST_FILE'] = 'NO'
    s['CODE_SIGN_ENTITLEMENTS'] = "#{name}/#{ent}"
    s['IPHONEOS_DEPLOYMENT_TARGET'] = DEPLOYMENT_TARGET
    s['SWIFT_VERSION'] = '5.0'
    s['TARGETED_DEVICE_FAMILY'] = '1,2'
    s['MARKETING_VERSION'] = '1.0'
    s['CURRENT_PROJECT_VERSION'] = '1'
    s['SKIP_INSTALL'] = 'YES'
    s['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
    s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
    s['ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME'] = 'AccentColor' if File.exist?(File.join(dir, 'Assets.xcassets'))
  end
  if File.exist?(File.join(dir, 'Assets.xcassets'))
    ref = group.files.find { |r| r.path == 'Assets.xcassets' } || group.new_reference('Assets.xcassets')
    target.resources_build_phase.add_file_reference(ref, true) unless target.resources_build_phase.files_references.include?(ref)
  end
end

add_extension(proj, app, embed, shared, shared_files, 'ShareExtension', 'ShareExtension', frameworks: %w[UniformTypeIdentifiers])
add_extension(proj, app, embed, shared, shared_files, 'TodayWidget', 'TodayWidget', frameworks: %w[WidgetKit SwiftUI])

proj.save
puts proj.targets.map { |t| "#{t.name}: #{t.source_build_phase.files_references.map(&:path).join(', ')}" }
